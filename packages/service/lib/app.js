'use strict';
// The registry's HTTP application. Every route is defined once and served under
// both /v0.1 and /v0 (spec section 4.1: mcp-publisher only speaks /v0).
const express = require('express');
const pkg = require('../package.json');
const {sendJson, problem, handle} = require('./http/problem');
const {readCors} = require('./http/cors');
const {serversRouter} = require('./read/servers');
const {toServerResponse} = require('./read/response');
const {mirrorState, mirrorSummary} = require('./mirror/sync');
const {writeRouter, recordReadRouter} = require('./publish/routes');
const {denyAll} = require('./auth/permissions');

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

// Body errors from express.json, answered as problem+json with their own detail.
const BODY_ERRORS = {
  'entity.parse.failed': [400, 'The request body is not valid JSON'],
  'entity.too.large': [413, 'The request body exceeds 1 MiB']
};

// `auth` (lib/auth/middleware.js createAuth, or the tests' fakeAuth) decides the
// write routes and, when it has a router, serves the token exchanges; without
// one, nothing authenticates.
function createApp({store, config, log, auth = denyAll, versionInfo = defaultVersionInfo(), now = () => new Date()}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', 'simple');
  // Behind a reverse proxy, req.ip (the exchange rate limit's key) is the
  // address that proxy appended to X-Forwarded-For: one hop is trusted, so an
  // entry the client wrote itself never counts. It is held only in the
  // limiter's memory (spec 9.6).
  app.set('trust proxy', config.listen.trustProxy === true ? 1 : false);

  const view = async (row) => toServerResponse(row, {publicHosting: config.publicHosting});

  const read = express.Router();
  read.use(readCors);
  read.use(serversRouter({store, log, view}));
  read.use(recordReadRouter({store, log}));
  read.get('/ping', (req, res) => sendJson(res, 200, {pong: true}));
  read.get('/version', (req, res) => sendJson(res, 200, versionInfo));
  read.get(`${X}/mirror`, handle(log, 'Failed to read the mirror state', async (req, res) => {
    // Public: the aggregate only; an upstream's name is the operator's topology.
    sendJson(res, 200, mirrorSummary(await mirrorState(store, now())));
  }));
  read.get('/health', async (req, res) => {
    if (await storeOk(store)) sendJson(res, 200, {status: 'ok'});
    else sendJson(res, 503, {status: 'error'});
  });

  // The write routes first: they send no CORS headers (spec 4.1).
  const write = writeRouter({store, config, log, auth, now, view});
  for (const prefix of ['/v0.1', '/v0']) {
    if (auth.router) app.use(prefix, auth.router);
    app.use(prefix, write, read);
  }

  app.get('/healthz', async (req, res) => {
    // Internal (the operator docs say not to expose it): the aggregate plus the
    // named per-upstream list.
    const all = await mirrorState(store, now()).catch(() => null);
    const mirror = all && mirrorSummary(all);
    const upstreams = all && all.upstreams;
    if (await storeOk(store)) sendJson(res, 200, {ok: true, store: 'ok', mirror, upstreams});
    else sendJson(res, 503, {ok: false, store: 'error', mirror, upstreams});
  });

  app.use((req, res) => problem(res, 404, 'Endpoint not found.'));

  // Errors raised before a handler runs (a path segment that is not valid
  // percent-encoding) answer as problem+json, never Express's HTML page.
  app.use((err, req, res, next) => {
    if (BODY_ERRORS[err.type]) return problem(res, ...BODY_ERRORS[err.type]);
    // Any other body-parser error (encoding, charset, an aborted request).
    if (err.type && err.status >= 400 && err.status < 500) return problem(res, err.status, 'The request body could not be read');
    if (err instanceof URIError || err.status === 400) return problem(res, 400, 'Invalid server name encoding');
    log.error('http.error', 'an unhandled request error', {code: err.code || err.name});
    return problem(res, 500, 'Internal server error');
  });
  return app;
}

module.exports = {createApp};
