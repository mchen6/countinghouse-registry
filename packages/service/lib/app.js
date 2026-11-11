'use strict';
// The registry's HTTP application. Every route is defined once and served under
// both /v0.1 and /v0 (spec section 4.1: mcp-publisher only speaks /v0).
const express = require('express');
const pkg = require('../package.json');
const {sendJson, problem, handle} = require('./http/problem');
const {readCors} = require('./http/cors');
const {serversRouter} = require('./read/servers');
const {toServerResponse} = require('./read/response');
const {mirrorState} = require('./mirror/sync');

const X = '/x/io.github.mchen6/countinghouse-registry';

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

function createApp({store, config, log, versionInfo = defaultVersionInfo(), now = () => new Date()}) {
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
  read.get(`${X}/mirror`, handle(log, 'Failed to read the mirror state', async (req, res) => {
    sendJson(res, 200, await mirrorState(store, now()));
  }));
  read.get('/health', async (req, res) => {
    if (await storeOk(store)) sendJson(res, 200, {status: 'ok'});
    else sendJson(res, 503, {status: 'error'});
  });

  for (const prefix of ['/v0.1', '/v0']) app.use(prefix, read);

  app.get('/healthz', async (req, res) => {
    const mirror = await mirrorState(store, now()).catch(() => null);
    if (await storeOk(store)) sendJson(res, 200, {ok: true, store: 'ok', mirror});
    else sendJson(res, 503, {ok: false, store: 'error', mirror});
  });

  app.use((req, res) => problem(res, 404, 'Endpoint not found.'));

  // Errors raised before a handler runs (a path segment that is not valid
  // percent-encoding) answer as problem+json, never Express's HTML page.
  app.use((err, req, res, next) => {
    if (err instanceof URIError || err.status === 400) return problem(res, 400, 'Invalid server name encoding');
    log.error('http.error', 'an unhandled request error', {code: err.code || err.name});
    return problem(res, 500, 'Internal server error');
  });
  return app;
}

module.exports = {createApp};
