'use strict';
// A service app over a fresh temporary store, for HTTP tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {openStore} = require('../../lib/store');
const {createApp} = require('../../lib/app');
const {createLogger} = require('../../lib/log');
const {listen} = require('./http');

const BASE_CONFIG = {
  listen: {host: '127.0.0.1', port: 9800, trustProxy: false},
  upstreams: [{name: 'official', url: 'https://registry.example', intervalMinutes: 60, reconcile: {everyDays: 7, atHour: 3}}],
  claims: [], publisherKeys: [], instances: [], publicHosting: 'aggregate'
};

async function startApp({config = {}, deps = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-app-'));
  const store = await openStore(path.join(dir, 'r.db'));
  const lines = [];
  const log = createLogger({stream: {write: (s) => { lines.push(s); return true; }}});
  const cfg = {...BASE_CONFIG, store: {path: path.join(dir, 'r.db')}, ...config};
  const app = createApp({store, config: cfg, log, ...deps});
  const server = await listen(app);
  return {
    url: server.url, store, logLines: lines, config: cfg,
    close: async () => { await server.close(); await store.close(); fs.rmSync(dir, {recursive: true, force: true}); }
  };
}

module.exports = {startApp, BASE_CONFIG};
