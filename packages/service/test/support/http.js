'use strict';
// Test servers listen on 127.0.0.1, ports 9700-9719 only (the brief's range),
// under the shared lock that `npm test` takes (scripts/with-suite-lock.js).
const http = require('http');

const FIRST = 9700;
const LAST = 9719;

function tryPort(app, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function listen(app) {
  for (let port = FIRST; port <= LAST; port++) {
    try {
      const server = await tryPort(app, port);
      return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(() => resolve()))
      };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('no free port in 9700-9719');
}

module.exports = {listen};
