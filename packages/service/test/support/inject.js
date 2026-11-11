'use strict';
// In-process HTTP for tests (spec section 14: "HTTP tests prefer in-process
// request injection so they need no port"). Each request runs over a
// stream.duplexPair() handed to an http.Server as its connection, so the app
// sees a real IncomingMessage (headers, body parsing, req.ip with or without
// `trust proxy`) and nothing listens.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {duplexPair} = require('stream');
const {openStore} = require('../../lib/store');
const {createApp} = require('../../lib/app');
const {createLogger} = require('../../lib/log');
const {BASE_CONFIG} = require('./app');

// -> {status, headers, text, body (parsed JSON, or undefined)}.
function inject(server, {method = 'GET', path: p, headers = {}, body, remoteAddress = '192.0.2.10'}) {
  return new Promise((resolve, reject) => {
    const [serverSide, clientSide] = duplexPair();
    Object.defineProperty(serverSide, 'remoteAddress', {value: remoteAddress});
    server.emit('connection', serverSide);
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = {host: 'registry.test', ...headers};
    if (payload !== undefined) {
      h['content-type'] = h['content-type'] || 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({method, path: p, headers: h, createConnection: () => clientSide}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        clientSide.destroy();
        resolve({status: res.statusCode, headers: res.headers, text, body: parsed});
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// A service app over a fresh temporary store, reached by injection.
// makeDeps({config, log}) -> extra createApp options (auth, now, ...).
async function injectApp({config = {}, makeDeps = () => ({})} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-inj-'));
  const store = await openStore(path.join(dir, 'r.db'));
  const lines = [];
  const log = createLogger({stream: {write: (s) => { lines.push(s); return true; }}});
  const cfg = {...BASE_CONFIG, store: {path: path.join(dir, 'r.db')}, ...config,
    listen: {...BASE_CONFIG.listen, ...(config.listen || {})}};
  const deps = makeDeps({config: cfg, log});
  const app = createApp({store, config: cfg, log, ...deps});
  const server = http.createServer(app);
  return {
    store, logLines: lines, config: cfg, deps, dir,
    request: (opts) => inject(server, opts),
    close: async () => { await store.close(); fs.rmSync(dir, {recursive: true, force: true}); }
  };
}

module.exports = {inject, injectApp};
