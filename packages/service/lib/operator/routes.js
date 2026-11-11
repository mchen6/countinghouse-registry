'use strict';
// The operator endpoints (the `operate` permission, spec 10.1), under
// /v0.1/x/io.github.mchen6/countinghouse-registry and /v0/x/...:
//   GET  conflicts                                       the 7.2 conflicts
//   POST conflicts/{name}/versions/{version}/acknowledge  allows new enables (7.2)
//   POST|DELETE overrides/{name}/versions/{version}      keepDeleted (7.3)
//   POST mirror/sync                                     sync now, {upstream?}
//   GET  mirror/upstreams                                the named per-upstream state (6.8)
// No CORS headers. Each action writes an audit row naming the key by its
// fingerprint, never the token; an acknowledgement or an override change takes a
// change sequence value for that name@version's enables, so instances see it on
// their next poll (9.4). Operator reads (operatorDetail) add the conflict flag
// and the upstream attribution to served records (6.8).
const express = require('express');
const {sendJson, problem, handle} = require('../http/problem');
const {mirrorState} = require('../mirror/sync');
const {serverHash, touchEnables} = require('../publish/conflicts');

// A recorded 7.2 conflict not yet acknowledged: it blocks new enables (Task 8).
async function openConflict(tx, name, version) {
  return Boolean(await tx.get('SELECT 1 AS x FROM conflicts WHERE name = ? AND version = ? AND ack_at IS NULL', [name, version]));
}

// The keepDeleted override (7.3): permits enables of a deleted or gone version.
async function hasOverride(tx, name, version) {
  return Boolean(await tx.get('SELECT 1 AS x FROM overrides WHERE name = ? AND version = ? AND keep_deleted = 1', [name, version]));
}

async function audit(tx, actor, action, subject, at) {
  await tx.run('INSERT INTO audit (at, key_fp, action, subject) VALUES (?, ?, ?, ?)', [at, actor.fp, action, subject]);
}

const conflictView = (r) => ({name: r.name, version: r.version, localSha256: r.local_sha, upstreamSha256: r.upstream_sha,
  firstSeen: r.first_seen, acknowledgedBy: r.ack_by, acknowledgedAt: r.ack_at});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = (res, errors) => problem(res, 422, 'validation failed', {errors});

// For an operator read of a served row: {conflict, upstream, alsoAt, differsAt}.
// For a mirrored row, alsoAt and differsAt are the lower-precedence upstreams
// whose copy is identical (the 7.2 comparison) or differs from the one served;
// for a local row, every upstream with a visible copy, and no `upstream`.
async function operatorDetail(store, row) {
  const detail = {};
  const [c] = await store.read('SELECT 1 AS x FROM conflicts WHERE name = ? AND version = ?', [row.name, row.version]);
  if (c) detail.conflict = true;
  if (row.source === 'local') {
    // Nothing is served from an upstream; every visible copy agrees or differs.
    const copies = await store.read(`SELECT s.upstream, s.server FROM record_sources s JOIN mirror_upstreams u ON u.name = s.upstream
      WHERE s.name = ? AND s.version = ? AND s.hidden_reason IS NULL ORDER BY u.position`, [row.name, row.version]);
    const local = serverHash(row.server);
    detail.alsoAt = [];
    detail.differsAt = [];
    for (const x of copies) (serverHash(x.server) === local ? detail.alsoAt : detail.differsAt).push(x.upstream);
  } else if (row.upstream) {
    const copies = await store.read(`SELECT s.upstream, s.server, u.position FROM record_sources s JOIN mirror_upstreams u ON u.name = s.upstream
      WHERE s.name = ? AND s.version = ? AND s.hidden_reason IS NULL ORDER BY u.position`, [row.name, row.version]);
    const serving = copies.find((x) => x.upstream === row.upstream);
    const served = serverHash(row.server);
    detail.upstream = row.upstream;
    detail.alsoAt = [];
    detail.differsAt = [];
    for (const x of copies) {
      if (!serving || x.position <= serving.position) continue;
      (serverHash(x.server) === served ? detail.alsoAt : detail.differsAt).push(x.upstream);
    }
  }
  return detail;
}

function operatorRouter({store, config, log, auth, now, mirror}) {
  const router = express.Router();
  const operate = auth.require('operate');
  const json = express.json({limit: '1mb', strict: false});
  const logged = (req, action, subject) => log.info('operator.action', 'an operator action', {action, subject, sub: req.actor.sub, fingerprint: req.actor.fp});
  const subjectOf = (req) => `${req.params.name}@${req.params.version}`;

  router.get('/conflicts', operate, handle(log, 'Failed to list conflicts', async (req, res) => {
    const rows = await store.read('SELECT * FROM conflicts ORDER BY name, version');
    sendJson(res, 200, {conflicts: rows.map(conflictView)});
  }));

  router.post('/conflicts/:name/versions/:version/acknowledge', operate, handle(log, 'Failed to acknowledge the conflict', async (req, res) => {
    const {name, version} = req.params;
    const at = now().toISOString();
    const result = await store.write(async (tx) => {
      const row = await tx.get('SELECT * FROM conflicts WHERE name = ? AND version = ?', [name, version]);
      if (!row) return null;
      if (row.ack_at !== null) return {row, changed: false};
      await tx.run('UPDATE conflicts SET ack_by = ?, ack_at = ? WHERE name = ? AND version = ?', [req.actor.fp, at, name, version]);
      await audit(tx, req.actor, 'conflict.acknowledge', subjectOf(req), at);
      await touchEnables(tx, name, version);
      return {row: {...row, ack_by: req.actor.fp, ack_at: at}, changed: true};
    });
    if (!result) return problem(res, 404, `No conflict is recorded for ${subjectOf(req)}`);
    if (result.changed) logged(req, 'conflict.acknowledge', subjectOf(req));
    return sendJson(res, 200, conflictView(result.row));
  }));

  router.post('/overrides/:name/versions/:version', operate, json, handle(log, 'Failed to set the override', async (req, res) => {
    const body = req.body;
    if (!isObject(body)) return invalid(res, [{message: 'expected object', location: 'body', value: body === undefined ? null : body}]);
    const errors = Object.keys(body).filter((k) => k !== 'keepDeleted').map((k) => ({message: 'unexpected property', location: `body.${k}`, value: body}));
    if (!('keepDeleted' in body)) errors.push({message: 'expected required property keepDeleted to be present', location: 'body', value: body});
    else if (body.keepDeleted !== true) errors.push({message: 'expected value to be true', location: 'body.keepDeleted', value: body.keepDeleted});
    if (errors.length) return invalid(res, errors);
    const {name, version} = req.params;
    const at = now().toISOString();
    const outcome = await store.write(async (tx) => {
      const rec = await tx.get('SELECT hidden_reason, official FROM records WHERE name = ? AND version = ?', [name, version]);
      if (!rec) return 'missing';
      // The operator accepts a version that is deleted or gone, never one in
      // advance (7.3).
      if (rec.hidden_reason === null && JSON.parse(rec.official).status !== 'deleted') return 'live';
      await tx.run(`INSERT INTO overrides (name, version, keep_deleted, by_key, at) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT (name, version) DO UPDATE SET keep_deleted = 1, by_key = excluded.by_key, at = excluded.at`, [name, version, req.actor.fp, at]);
      await audit(tx, req.actor, 'override.set', subjectOf(req), at);
      await touchEnables(tx, name, version);
      return 'set';
    });
    if (outcome === 'missing') return problem(res, 404, 'Server version not found');
    if (outcome === 'live') return problem(res, 409, `${subjectOf(req)} is neither deleted nor gone upstream; keepDeleted applies only to a version that is deleted or gone`);
    logged(req, 'override.set', subjectOf(req));
    return sendJson(res, 200, {name, version, keepDeleted: true, by: req.actor.fp, at});
  }));

  router.delete('/overrides/:name/versions/:version', operate, handle(log, 'Failed to remove the override', async (req, res) => {
    const {name, version} = req.params;
    const at = now().toISOString();
    const removed = await store.write(async (tx) => {
      if (!(await tx.get('DELETE FROM overrides WHERE name = ? AND version = ? RETURNING name', [name, version]))) return false;
      await audit(tx, req.actor, 'override.remove', subjectOf(req), at);
      await touchEnables(tx, name, version);
      return true;
    });
    if (!removed) return problem(res, 404, `No override is recorded for ${subjectOf(req)}`);
    logged(req, 'override.remove', subjectOf(req));
    return res.status(204).end();
  }));

  router.post('/mirror/sync', operate, json, handle(log, 'Failed to start a mirror run', async (req, res) => {
    const body = req.body === undefined ? {} : req.body;
    if (!isObject(body)) return invalid(res, [{message: 'expected object', location: 'body', value: body}]);
    const errors = Object.keys(body).filter((k) => k !== 'upstream').map((k) => ({message: 'unexpected property', location: `body.${k}`, value: body}));
    if ('upstream' in body && typeof body.upstream !== 'string') errors.push({message: 'expected string', location: 'body.upstream', value: body.upstream});
    if (errors.length) return invalid(res, errors);
    const {upstream} = body;
    if (config.upstreams.length === 0) return problem(res, 404, 'No upstreams are configured');
    if (upstream !== undefined && !config.upstreams.some((u) => u.name === upstream)) return problem(res, 404, `No upstream named ${upstream} is configured`);
    if (!mirror) return problem(res, 503, 'The mirror is not running');
    const {started} = mirror.runNow(upstream);
    if (!started) return problem(res, 409, 'A mirror run is already in progress');
    const subject = upstream === undefined ? 'all' : upstream;
    await store.write((tx) => audit(tx, req.actor, 'mirror.sync', subject, now().toISOString()));
    logged(req, 'mirror.sync', subject);
    return sendJson(res, 202, {started: true});
  }));

  router.get('/mirror/upstreams', operate, handle(log, 'Failed to read the mirror state', async (req, res) => {
    sendJson(res, 200, await mirrorState(store, now()));
  }));

  return router;
}

module.exports = {operatorRouter, operatorDetail, openConflict, hasOverride};
