/* Zero-dependency static server for local preview of the Romzo website. */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var port = 7100;
var host = '127.0.0.1';
var args = process.argv.slice(2);

for (var i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) port = Number(args[++i]);
  if ((args[i] === '--host' || args[i] === '-H') && args[i + 1]) host = args[++i];
}
if (process.env.PORT) port = Number(process.env.PORT);

var root = __dirname;
var types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

http.createServer(function (req, res) {
  var pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  var file = path.normalize(path.join(root, pathname));
  if (file !== root && file.indexOf(root + path.sep) !== 0) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, host, function () {
  console.log('romzo website → http://' + host + ':' + port + '/');
});
