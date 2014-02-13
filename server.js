#!/usr/bin/env node

var restify = require('restify')
  , Cookies = require('cookies')
  , fs = require('fs')
  , tar = require('tar')
  , zlib = require('zlib')
  , path = require('path')
  , rimraf = require('rimraf')
  , mkdirp = require('mkdirp')
  , semver = require('semver')
  , optimist = require('optimist')
  , request = require('request');

// ----------------------------------------------------------------------------
// options parsing
// ----------------------------------------------------------------------------

// TODO - add option for setting host
var defaults = {
    d : path.join(process.cwd(), 'data'),
    p : 8080,
    H: '0.0.0.0',
    h: '0.0.0.0',
    s: ''
  },
  argv = optimist
    .usage('Reggie wants to serve your packages!\nUsage: $0')
    //.demand(['d'])
    .default(defaults)
    .alias('d', 'data')
    .alias('p', 'port')
    .alias('H', 'listen')
    .alias('u', 'url')
    .alias('c', 'cert')
    .alias('k', 'key')
    .alias('s', 'security')
    .alias('h', 'host')
    .describe('d', 'Directory to store Reggie\'s data')
    .describe('p', 'Reggie\'s a good listener. What port should I listen on?')
    .describe('H', 'Which host should Reggie listen on?')
    .describe('u', 'URL where `npm` can access registry (usually http://{hostname}:{port}/)')
    .describe('s', 'What (long) prefix should be in the first part of the path (for security)?')
    .describe('c', 'Path to the SSL certificate')
    .describe('k', 'Path to the SSL key')
    .describe('h', 'Host clients should address when communicating with this server')
    .argv;

if (argv.help) {
  optimist.showHelp();
  process.exit(0);
}

// ----------------------------------------------------------------------------
// SSL & security setup
// ----------------------------------------------------------------------------

var prefix = argv.s ? "/" + argv.s : '', cert, key;

// Validate SSL
if (!!argv.c !== !!argv.k) {
  console.error("To use SSL, both the SSL key and certificate must be passed (options c and k).")
  process.exit(1);
}

if (argv.c) {
  key = fs.readFileSync(argv.k);
  cert = fs.readFileSync(argv.c);
}

// ----------------------------------------------------------------------------
// proxy server
// ----------------------------------------------------------------------------

var proxy = "https://registry.npmjs.org";


// ----------------------------------------------------------------------------
// data initialization
// ----------------------------------------------------------------------------

var config = {
  dataDirectory: argv.data,
  registryUrl: normalizeUrl(argv.url || (cert ? 'https://' : 'http://') + argv.h + ':' + argv.p + prefix)
}

var Data = require('./lib/data');
var data = new Data(config);

data.init(function (err) {
  console.log("Starting to load packages in " + data._packagesDir);
  data.reloadPackages(function (err) {
    if (err) throw err;
    console.log("Done auto-loading packages")
  });
});

function normalizeUrl(url) {
  if (url.match(/\/$/))
    return url;
  return url + '/';
}

// ----------------------------------------------------------------------------
// server wireup
// ----------------------------------------------------------------------------

var server = !cert ? restify.createServer() : restify.createServer({
    certificate: cert,
    key: key
  });
  

server.use(restify.bodyParser());

server.get(prefix + '/', function (req, res) {
  res.send('Reggie says hi')
});

server.put(prefix + '/package/:name/:version', function (req, res, next) {
  var name = req.params.name;
  var version = req.params.version;
  var rand = Math.floor(Math.random()*4294967296).toString(36);
  var tempPackageFile = path.join(argv.data, "temp", rand + name + "-" + version + ".tgz");

  // write the tar file. Don't combine the streamed gzip and untar on upload just yet...
  fs.writeFile(tempPackageFile, req.body, function(err) {
    if (err) {
      console.error("Unexpected error when accepting package upload: " + (err.message || err));
      return res.send(500, err);
    }

    data.loadPackage(tempPackageFile, name, version, function (err) {
      if (err) {
        console.error("Error loading package from upload: " + (err.message || err));
        fs.unlink(tempPackageFile);
        return res.send(500, err);
      }

      fs.unlink(tempPackageFile);
      res.send(200);
    });
  });
});

server.del(prefix + '/package/:name/:version', function (req, res, next) {
  var name = req.params.name;
  var version = req.params.version;

  data.deletePackage(name, version, function (err) {
    if (err) {
      console.error("Error deleting package " + name + "@" + version + ": " + (err.message || err));
      return res.send(500, err);
    }
    res.send(200);
  });
});

server.get(prefix + '/versions/:name', function (req, res) {
  var name = req.params.name;
  res.send(data.whichVersions(name));
});

server.get(prefix + '/package/:name/:range', function (req, res, next) {
  var name = req.params.name;
  var range = req.params.range;
  if (range === 'latest') 
    range = 'x.x.x';
  returnPackageByRange(name, range, res);
});

server.get(prefix + '/index', function (req, res) {
  res.send(data.index());
});

server.get(prefix + '/info/:name', function (req, res) {
  var name = req.params.name;  
  var meta = data.packageMeta(name);
  if (!meta) return res.send(404);
  else return res.send(meta);
});

// ----------------------------------------------------------------------------
// NPM registry protocol
// ----------------------------------------------------------------------------


server.get(prefix + '/-/all/since', listAction);
server.get(prefix + '/-/all', listAction);

server.put(prefix + '/:name', function (req, res) {
  // TODO verify that req.params.name is the same as req.body.name
  data.updatePackageMetadata(req.body);
  res.json(200, { ok: true });
});

function getProxy(req, res) {
  var url = proxy + '/' + req.params.name, x;
  if (x = req.params.version) url += '/' + x;

  request.get(url, function (err, resp, body) {
    try {
      if (err) throw err;
      res.json(JSON.parse(body));
    } catch (err) {
      res.json(500, { error: err })
    }
  });
}

function notFound(res) {
  return res.json(404, { error: "not_found", reason: "document not found" });
}

server.get(prefix + '/:name', function (req, res) {
  var packageName = req.params.name;
  var meta = data.packageMeta(packageName);
  if (!meta) return getProxy(req, res);

  var versions =  data.whichVersions(packageName).sort();
  var versionsData = {};
  var times = {};
  versions.forEach(function(v) {
    versionsData[v] = meta.versions[v].data;
    times[v] = meta.versions[v].time;
  });

  var result = {
    _id: packageName,
    _rev: '1-0',
    name: meta.name,
    description: meta.description,
    'dist-tags': {
      latest: versions[versions.length-1]
    },
    versions: versionsData,
    maintainers: [],
    author: meta.author,
    repository: meta.repository,
    time: times
  };
  res.json(200, result);
});

server.get(prefix + '/:name/:version', function (req, res) {
  var name = req.params.name;
  var version = req.params.version;

  var meta = data.packageMeta(name);
  if (!meta) return getProxy(req, res);

  if (version === 'latest') version = 'x.x.x';
  version = semver.maxSatisfying(data.whichVersions(name), version);

  var versionMeta = meta.versions[version];
  if (!versionMeta) return notFound(res);

  res.json(200, versionMeta.data);
});

function listAction(req, res) {
  var result = {
    _updated: 0
  };

  data.getAllPackageNames()
    .forEach(function(name) {
      result[name] = getPackageInfo(name);
    });

  res.json(200, result);

  function getPackageInfo(packageName) {
    var versions =  data.whichVersions(packageName).sort();
    var meta = data.packageMeta(packageName);
    var lastVersion = versions[versions.length-1];
    var versionsData = {};
    versions.forEach(function(v) {
      versionsData[v] = 'latest';
    });

    return {
      _id: meta.name,
      name: meta.name,
      description: meta.description,
      'dist-tags': {
        latest: lastVersion
      },
      versions: versionsData,
      maintainers: [],
      author: meta.author,
      repository: meta.repository,
      time: {
        modified: meta.versions[lastVersion].time
      }
    };
  }
}

server.put(prefix + '/:name/-/:filename/-rev/:rev', function (req, res) {
  var filename = req.params.filename;
  var rand = Math.floor(Math.random()*4294967296).toString(36);
  var tempPackageFile = path.join(argv.data, "temp", rand + '-' + filename);
  fs.writeFile(tempPackageFile, req.body, function(err) {
    if (err) {
      console.log('Cannot save package to a temp file %s: %s', tempPackageFile, err.message);
      return res.json(500, { error: 'internal_server_error', reason: err.toString() });
    }
    data.loadPackage(tempPackageFile, function(err) {
      if (err) {
        console.error('Error loading package from upload: ' + (err.message || err));
        fs.unlink(tempPackageFile);
        return res.json(400, { error: 'bad_request', reason: 'package file cannot be read'});
      }
      return res.json(201, {
        ok: true,
        id: '-',
        rev: '1-0'
      });
    });
  });
});

server.put(prefix + '/:name/:version/-tag/:tag', function(req, res) {
  res.json(201, {
    ok: true,
    id: req.params.tag,
    rev: '1-0'
  });
});

server.get(prefix + '/:name/-/:file', function(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream'});
  fs.createReadStream(path.join(data._packagesDir, req.params.file))
    .pipe(res);
});


function fix(path) {
  return {
    path: path,
    urlParamPattern: '([a-zA-Z0-9-_~\\.%@:]+)' // added ':' to the white-list
  };
}

server.put(fix(prefix + '/-/user/:user'), function(req, res) {
  res.json(201, {
    ok: true,
    id: req.params.user,
    rev: '1-0'
  });
});

server.post(prefix + '/_session', function(req, res) {
  // TODO - verify login & password

  var cookies = new Cookies(req, res);
  // refresh auth session in the client or set a new 'dummy' one
  cookies.set('AuthSession', cookies.get('AuthSession') || 'dummy');

  res.json(200, {
    ok: true,
    name: req.body.name,
    roles: []
  });
});

/* Middleware for logging all incoming requests *
server.pre(function (req, res, next) {
  console.log('< %s %s', req.method, req.url);
  console.log(JSON.stringify(req.headers, null, 2));
  console.log('> %s %s', res.statusCode, res.statusText);
  console.log();
  next();
});
/**/

server.listen(argv.port, argv.listen, function() {
  console.log('Reggie listening at %s', server.url);
  console.log('NPM registry URL:\n  %s\n', config.registryUrl);
});

// ----------------------------------------------------------------------------
// register permutations of gt,lt,gte,lte routes for semver magic 
// ----------------------------------------------------------------------------

var ops = [['gt', '>'], ['lt', '<'], ['gte', '>='], ['lte', '<=']]

ops.forEach(function (op1) {
  //console.log (op1);
  registerOp(op1);
  ops.forEach(function (op2) {
    if (op1 != op2) {
      //console.log(op1, op2);
      registerOp(op1, op2);
    }
  })
})

function registerOp (op1, op2) {
  if (!op2) {
    //console.log('/package/:name/' + op1[0] + '/:v1')
    server.get(prefix + '/package/:name/' + op1[0] + '/:v1', function (req, res, next) {
      var name = req.params.name;
      var v1 = req.params.v1;
      var range = op1[1] + v1;
      returnPackageByRange(name, range, res);
    });    
  }
  else {
    //console.log('/package/:name/' + op1[0] + '/:v1/' + op2[0] + '/:v2')
    server.get(prefix + '/package/:name/' + op1[0] + '/:v1/' + op2[0] + '/:v2', function (req, res, next) {
      var name = req.params.name;
      var v1 = req.params.v1;
      var v2 = req.params.v2;
      var range = op1[1] + v1 + ' ' + op2[1] + v2;
      returnPackageByRange(name, range, res);
    });    

  }
}

function returnPackageByRange (name, range, res) {
  var version = semver.maxSatisfying(data.whichVersions(name), range);
  console.log("semver range calculation of (" + name, range + ")  ==> ", version);

  if (!version) { 
    return res.send(404) 
  }

  var filename = name + '-' + version + '.tgz';
  res.contentType = 'application/x-compressed';
  res.header( "Content-Disposition", "filename=" + filename );

  data.openPackageStream(name, version, function (err, stream) {
    if (err) {
      console.error("Error streaming package: " + (err.message || err));
      res.send(500, err);
    }
    stream
      .pipe(res)
      .on('error', function (err) {
        res.send(500, err);
      });
  })
}


