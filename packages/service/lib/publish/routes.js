'use strict';
// The write routes (spec sections 4.2, 7 and 8.4), served under /v0.1 and /v0:
// POST /publish, POST /validate, PATCH .../status (both forms), PUT and DELETE of
// a version (501), and PUT/GET of countinghouse records. JSON bodies are at most
// 1 MiB (app.js answers the parse and size errors). No CORS headers.
const express = require('express');
const {sendJson, problem, handle} = require('../http/problem');
const {validateServerJson} = require('countinghouse-registry-cli/lib/validate');
const {publishServer, setStatus, putRecord, decodeProblem, PublishError} = require('./publish');

const X = '/x/io.github.mchen6/countinghouse-registry';

const sendError = (res, err) => problem(res, err.status, err.detail, err.extra);

// Runs fn; a PublishError is its problem response, anything else the 500 of handle.
const guarded = (log, failDetail, fn) => handle(log, failDetail, async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof PublishError) return sendError(res, err);
    throw err;
  }
});

// upstream answers a body its structs do not decode before authentication.
const decoded = (req, res, next) => {
  const bad = decodeProblem(req.body);
  return bad ? sendError(res, bad) : next();
};

function writeRouter({store, config, log, auth, now, view}) {
  const router = express.Router();
  // Bodies are parsed on the write routes only: a read is never refused for its body.
  const json = express.json({limit: '1mb', strict: false});
  const claims = config.claims || [];

  router.post('/publish', json, decoded, auth.require((req) => `publish:${req.body.name}`), guarded(log, 'Failed to publish server', async (req, res) => {
    const {row} = await publishServer(store, req.body, req.actor, {claims, now: now(), log});
    sendJson(res, 200, await view(row));
  }));

  // Public, as upstream's: always 200 {valid, issues} for a body that decodes.
  router.post('/validate', json, decoded, guarded(log, 'Failed to validate server', async (req, res) => {
    sendJson(res, 200, validateServerJson(req.body, {forPublish: false}));
  }));

  const publishOnPath = auth.require((req) => `publish:${req.params.name}`);
  router.patch('/servers/:name/versions/:version/status', json, publishOnPath, guarded(log, 'Failed to update server status', async (req, res) => {
    const {rows} = await setStatus(store, req.params.name, req.params.version, req.body, {now: now()});
    sendJson(res, 200, await view(rows[0]));
  }));
  router.patch('/servers/:name/status', json, publishOnPath, guarded(log, 'Failed to update server status', async (req, res) => {
    const {rows} = await setStatus(store, req.params.name, null, req.body, {now: now()});
    sendJson(res, 200, {updatedCount: rows.length, servers: await Promise.all(rows.map((r) => view(r)))});
  }));

  const immutable = (req, res) => problem(res, 501, 'Records are immutable once published: publish a new version, or change its status');
  router.put('/servers/:name/versions/:version', immutable);
  router.delete('/servers/:name/versions/:version', immutable);

  router.put(`${X}/records/:name/versions/:version`, json, publishOnPath, guarded(log, 'Failed to store the record', async (req, res) => {
    const {status, sha256} = await putRecord(store, req.params.name, req.params.version, req.body, {claims, now: now()});
    sendJson(res, status, {sha256});
  }));
  return router;
}

// GET .../records/{name}/versions/{version}: public, the record as stored.
function recordReadRouter({store, log}) {
  const router = express.Router();
  router.get(`${X}/records/:name/versions/:version`, handle(log, 'Failed to read the record', async (req, res) => {
    const [row] = await store.read('SELECT body FROM ch_records WHERE name = ? AND version = ?', [req.params.name, req.params.version]);
    if (!row) return problem(res, 404, 'Record not found');
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    return res.end(row.body);
  }));
  return router;
}

module.exports = {writeRouter, recordReadRouter};
