'use strict';
// The registry's HTTP application. Every route is defined once and served under
// both /v0.1 and /v0 (spec section 4.1: mcp-publisher only speaks /v0).
const express = require('express');
const pkg = require('../package.json');
const {sendJson, problem} = require('./http/problem');
const {readCors} = require('./http/cors');
const {serversRouter} = require('./read/servers');
const {toServerResponse} = require('./read/response');

function defaultVersionInfo() {
  return {
    version: pkg.version,
    git_commit: process.env.COUNTINGHOUSE_REGISTRY_GIT_COMMIT || 'unknown',
    build_time: process.env.COUNTINGHOUSE_REGISTRY_BUILD_TIME || 'unknown'
  };
}

async function storeOk(store) {
  try {
    await store.read('SELECT 1 AS ok');
    return true;
  } catch {
    return false;
  }
}

function createApp({store, config, log, mirror = null, versionInfo = defaultVersionInfo()}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', 'simple');

  const view = async (row) => toServerResponse(row, {publicHosting: config.publicHosting});

  const read = express.Router();
  read.use(readCors);
  read.use(serversRouter({store, log, view}));
  read.get('/ping', (req, res) => sendJson(res, 200, {pong: true}));
  read.get('/version', (req, res) => sendJson(res, 200, versionInfo));
  read.get('/health', async (req, res) => {
    if (await storeOk(store)) sendJson(res, 200, {status: 'ok'});
    else sendJson(res, 503, {status: 'error'});
  });

  for (const prefix of ['/v0.1', '/v0']) app.use(prefix, read);

  app.get('/healthz', async (req, res) => {
    const mirrorState = mirror ? await mirror.state().catch(() => null) : null;
    if (await storeOk(store)) sendJson(res, 200, {ok: true, store: 'ok', mirror: mirrorState});
    else sendJson(res, 503, {ok: false, store: 'error', mirror: mirrorState});
  });

  app.use((req, res) => problem(res, 404, 'Endpoint not found.'));
  return app;
}

module.exports = {createApp};
