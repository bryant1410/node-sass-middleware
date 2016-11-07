"use strict";

var sass = require('node-sass'),
    util = require('util'),
    fs = require('fs'),
    url = require('url'),
    dirname = require('path').dirname,
    mkdirp = require('mkdirp'),
    join = require('path').join;

var imports = {};

/**
 * Return Connect middleware with the given `options`.
 *
 * Options:
 *
 *    all supportend options from node-sass project plus following:
 *
 *    `src`            Source directory used to find .scss files
 *    `dest`           Destination directory used to output .css files when undefined defaults to `src`
 *    `root`           A base path for both source and destination directories
 *    `prefix`         It will tell the sass compiler that any request file will always be prefixed
 *                     with <prefix> and this prefix should be ignored.
 *    `force`          Always re-compile
 *    `debug`          Output debugging information
 *    `response`       True (default) to write output directly to response instead of to a file
 *    `error`          A function to be called when something goes wrong
 *    `maxAge`         MaxAge to be passed in Cache-Control header
 *
 *
 * Examples:
 *
 * Pass the middleware to Connect, grabbing .scss files from this directory
 * and saving .css files to _./public_.
 *
 * Following that we have a `staticProvider` layer setup to serve the .css
 * files generated by Sass.
 *
 *   var server = connect()
 *      .use(middleware({
 *        src: __dirname,
 *        dest: __dirname,
 *      }))
 *      .use(function(err, req, res, next) {
 *        res.statusCode = 500;
 *        res.end(err.message);
 *      });
 *
 * @param {Object} options
 * @return {Function}
 * @api public
 */

module.exports = function(options) {
  options = options || {};

  // Accept single src/dest dir
  if (typeof options == 'string') {
    options = { src: options };
  }

  var sassMiddlewareError = null;
  var cachedErrorCb = options.error;

  // This function will be called if something goes wrong
  var error = function(err) {
    if (cachedErrorCb) {
      cachedErrorCb(err);
    }

    sassMiddlewareError = err;
  };

  // Source directory (required)
  var src = options.src || function() {
    throw new Error('sass.middleware() requires "src" directory.');
  }();
  // Destination directory (source by default)
  var dest = options.dest || src;
  // Optional base path for src and dest
  var root = options.root || null;

  // Force compilation everytime
  var force = options.force || options.response;
  // Enable debug output
  var debug = options.debug;

  var sassExtension = (options.indentedSyntax === true) ? '.sass' : '.scss';

  var sourceMap = options.sourceMap || null;

  var maxAge = options.maxAge || 0;

  //Allow custom log function or default one
  var log = options.log || function (key, val) {
    console.error('  \x1B[90m%s:\x1B[0m \x1B[36m%s\x1B[0m', key, val);
  };
    
  // Default compile callback
  options.compile = options.compile || function() {
    return sass;
  };

  // Middleware
  return function sass(req, res, next) {
    if (req.method != 'GET' && req.method != 'HEAD') {
      return next();
    }

    var path = url.parse(req.url).pathname;
    if (options.prefix && 0 === path.indexOf(options.prefix)) {
      path = path.substring(options.prefix.length);
    }

    if (!/\.css$/.test(path)) {
      return next();
    }

    var cssPath = join(dest, path),
        sassPath = join(src, path.replace(/\.css$/, sassExtension)),
        sassDir = dirname(sassPath);

    if (root) {
      cssPath = join(root, dest, path.replace(new RegExp('^' + dest), ''));
      sassPath = join(root, src, path
          .replace(new RegExp('^' + dest), '')
          .replace(/\.css$/, sassExtension));
      sassDir = dirname(sassPath);
    }

    if (debug) {
      log('source', sassPath);
      log('dest', options.response ? '<response>' : cssPath);
    }

    // When render is done, respond to the request accordingly
    var done = function(err, result) {
      var data;

      if (err) {
        var file = sassPath;
        if (err.file && err.file != 'stdin') {
          file = err.file;
        }

        var fileLineColumn = file + ':' + err.line + ':' + err.column;
        data = err.message.replace(/^ +/, '') + '\n\nin ' + fileLineColumn;
        if (debug) logError(data);

        error(err);

        return next(err);
      }

      data = result.css;

      if (debug) {
        log('render', options.response ? '<response>' : sassPath);

        if (sourceMap) {
          log('render', this.options.sourceMap);
        }
      }
      imports[sassPath] = result.stats.includedFiles;

      var cssDone = true;
      var sourceMapDone = true;

      function doneWriting() {
        if (!cssDone || !sourceMapDone) {
          return;
        }

        if (options.response === false) {
          return next(sassMiddlewareError);
        }

        res.writeHead(200, {
          'Content-Type': 'text/css',
          'Cache-Control': 'max-age=' + maxAge
        });
        res.end(data);
      }

      // If response is falsey, also write to file
      if (options.response) {
        return doneWriting();
      }

      cssDone = false;
      sourceMapDone = !sourceMap;

      mkdirp(dirname(cssPath), '0700', function(err) {
        if (err) {
          return error(err);
        }

        fs.writeFile(cssPath, data, 'utf8', function(err) {
          if (err) {
            return error(err);
          }

          cssDone = true;
          doneWriting();
        });
      });

      if (sourceMap) {
        var sourceMapPath = this.options.sourceMap;
        mkdirp(dirname(sourceMapPath), '0700', function(err) {
          if (err) {
            return error(err);
          }

          fs.writeFile(sourceMapPath, result.map, 'utf8', function(err) {
            if (err) {
              return error(err);
            }
            sourceMapDone = true;
            doneWriting();
          });
        });
      }
    }

    // Compile to cssPath
    var compile = function() {
      if (debug) { log('read', cssPath); }

      fs.exists(sassPath, function(exists) {
        if (!exists) {
          return next();
        }

        imports[sassPath] = undefined;

        var style = options.compile();

        var renderOptions = util._extend({}, options);

        renderOptions.file = sassPath;
        renderOptions.outFile = options.outFile || cssPath;
        renderOptions.includePaths = [sassDir].concat(options.includePaths || []);

        style.render(renderOptions, done);
      });
    };

    // Force
    if (force) {
      return compile();
    }

    // Re-compile on server restart, disregarding
    // mtimes since we need to map imports
    if (!imports[sassPath]) {
      return compile();
    }

    // Compare mtimes
    fs.stat(sassPath, function(err, sassStats) {
      if (err) {
        error(err);
        return next();
      }

      fs.stat(cssPath, function(err, cssStats) {
        if (err) { // CSS has not been compiled, compile it!
          if ('ENOENT' === err.code) {
            if (debug) { log('not found', cssPath); }
            return compile();
          }

          return next(err);
        }

        if (sassStats.mtime > cssStats.mtime) { // Source has changed, compile it
          if (debug) { log('modified', cssPath); }
          return compile();
        }

        // Already compiled, check imports
        checkImports(sassPath, cssStats.mtime, function(changed) {
          if (debug && changed && changed.length) {
            changed.forEach(function(path) {
              log('modified import %s', path);
            });
          }
          changed && changed.length ? compile() : next();
        });
      });
    });
  }
};

/**
 * Check `path`'s imports to see if they have been altered.
 *
 * @param {String} path
 * @param {Function} fn
 * @api private
 */

function checkImports(path, time, fn) {
  var nodes = imports[path];
  if (!nodes || !nodes.length) {
    return fn();
  }

  var pending = nodes.length,
      changed = [];

  // examine the imported files (nodes) for each parent sass (path)
  nodes.forEach(function(imported) {
    fs.stat(imported, function(err, stat) {
      // error or newer mtime
      if (err || stat.mtime >= time) {
        changed.push(imported);
      }
      // decrease pending, if 0 call fn with the changed imports
      --pending || fn(changed);
    });
  });
}

/**
 * Log a message.
 *
 * @api private
 */

function logError(message) {
  log('error', '\x07\x1B[31m' + message + '\x1B[91m');
}
