'use strict';
// Local publishing (spec section 7.5), status changes of local records (4.2) and
// countinghouse records (8.4). Each runs in one write transaction; failures are
// PublishError(status, detail, extra), answered as problem+json by the routes.
const {validateServerJson, decodeErrors} = require('countinghouse-registry-cli/lib/validate');
const {validateRecord, recordHash, pointerOf} = require('countinghouse-registry-cli/lib/record');
const {depthWithin} = require('countinghouse-registry-cli/lib/canonical-json');
const {claimOf} = require('./namespaces');
const {recomputeLatest} = require('./latest');
const {rebuildNames} = require('../mirror/sources');
const {ROW_COLUMNS} = require('../read/response');
const {conflictLogger} = require('./conflicts');

const MAX_DEPTH = 64;
const MAX_TOOLS = 500;

class PublishError extends Error {
  constructor(status, detail, extra = {}) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.extra = extra;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hex12 = (s) => (typeof s === 'string' && s ? s.slice(0, 12) : 'none');

// upstream's body decode (huma): 422 "validation failed" with huma's errors.
function decodeProblem(body) {
  if (!isObject(body)) return new PublishError(422, 'validation failed', {errors: [{message: 'expected object', location: 'body', value: body === undefined ? null : body}]});
  const errors = decodeErrors(body);
  return errors.length ? new PublishError(422, 'validation failed', {errors}) : null;
}

function notClaimed(name) {
  return new PublishError(403, `${name} is not in a namespace claimed by this registry; publishing here is only for claimed namespaces`);
}

// POST /v0.1/publish: decode, then (in order, spec 7.5) claim, validation, our
// pointer rule, uniqueness; then the record is stored, compared with any upstream
// copy (7.2) and isLatest recomputed (7.4). -> {row}.
async function publishServer(store, doc, actor, {claims, now = new Date(), log = null}) {
  const decoded = decodeProblem(doc);
  if (decoded) throw decoded;
  if (!depthWithin(doc, MAX_DEPTH)) throw new PublishError(422, `The document is nested more than ${MAX_DEPTH} levels deep`);
  const {name, version} = doc;
  if (!claimOf(name, claims)) throw notClaimed(name);
  const result = validateServerJson(doc);
  if (!result.valid) throw new PublishError(422, 'Failed to publish server, invalid schema: call /validate for details', {issues: result.issues});
  const nowIso = now.toISOString();
  return store.write(async (tx) => {
    const pointer = pointerOf(doc);
    if (pointer) {
      const stored = await tx.get('SELECT sha256 FROM ch_records WHERE name = ? AND version = ?', [name, version]);
      if (!stored || pointer.sha256 !== stored.sha256) {
        throw new PublishError(422, `The countinghouse record pointer's sha256 (${hex12(pointer.sha256)}) does not match the record stored for ${name}@${version} (${stored ? hex12(stored.sha256) : 'none stored'}); PUT the record first`);
      }
    }
    const existing = await tx.get('SELECT source FROM records WHERE name = ? AND version = ?', [name, version]);
    if (existing && existing.source === 'local') throw new PublishError(409, `${name}@${version} is already published here; published versions are immutable`);
    const official = JSON.stringify({status: 'active', statusChangedAt: nowIso, publishedAt: nowIso, updatedAt: nowIso, isLatest: false});
    const server = JSON.stringify(doc);
    if (existing) {
      // A version the mirror already serves becomes local; its copies stay for 7.2.
      await tx.run(`UPDATE records SET source = 'local', origin = 'local', server = ?, official = ?, changed_at = ?, mirrored_at = NULL,
        upstream_updated_at = NULL, upstream = NULL, seen_pass = NULL, hidden_reason = NULL WHERE name = ? AND version = ?`, [server, official, nowIso, name, version]);
    } else {
      await tx.run(`INSERT INTO records (source, name, version, server, official, origin, changed_at) VALUES ('local', ?, ?, ?, ?, 'local', ?)`,
        [name, version, server, official, nowIso]);
    }
    // Compares with the winning upstream copy, if any, and recomputes isLatest
    // (the name now has a local record, so rebuildNames applies 7.4).
    await rebuildNames(tx, [name], nowIso, log ? {onConflict: conflictLogger(log)} : {});
    return {row: await tx.get(`SELECT ${ROW_COLUMNS} FROM records WHERE name = ? AND version = ?`, [name, version])};
  });
}

// upstream's UpdateServerStatusBody, decoded as huma does.
function statusBodyProblem(body) {
  if (!isObject(body)) return new PublishError(422, 'validation failed', {errors: [{message: 'expected object', location: 'body', value: body === undefined ? null : body}]});
  const errors = [];
  for (const k of Object.keys(body)) if (k !== 'status' && k !== 'statusMessage') errors.push({message: 'unexpected property', location: `body.${k}`, value: body});
  if (!('status' in body)) errors.push({message: 'expected required property status to be present', location: 'body', value: body});
  else if (!['active', 'deprecated', 'deleted'].includes(body.status)) errors.push({message: 'expected value to be one of "active, deprecated, deleted"', location: 'body.status', value: body.status});
  if ('statusMessage' in body && (typeof body.statusMessage !== 'string' || [...body.statusMessage].length > 500)) {
    errors.push({message: 'expected string of at most 500 characters', location: 'body.statusMessage', value: body.statusMessage});
  }
  return errors.length ? new PublishError(422, 'validation failed', {errors}) : null;
}

// PATCH .../versions/{version}/status (version given) or .../status (every local
// version). Local records only: a mirrored one follows upstream (409).
// -> {rows}.
async function setStatus(store, name, version, body, {now = new Date()} = {}) {
  const bad = statusBodyProblem(body);
  if (bad) throw bad;
  if (body.status === 'active' && body.statusMessage !== undefined) throw new PublishError(400, 'status_message cannot be provided when setting status to active');
  const nowIso = now.toISOString();
  return store.write(async (tx) => {
    const rows = version === null
      ? await tx.all('SELECT version, source, official FROM records WHERE name = ? ORDER BY version', [name])
      : await tx.all('SELECT version, source, official FROM records WHERE name = ? AND version = ?', [name, version]);
    if (!rows.length) throw new PublishError(404, version === null ? 'Server not found' : 'Server version not found');
    const locals = rows.filter((r) => r.source === 'local');
    if (!locals.length) throw new PublishError(409, 'mirrored records follow upstream; use an override');
    const message = body.status === 'active' ? undefined : body.statusMessage;
    const changing = locals.filter((r) => {
      const o = JSON.parse(r.official);
      return o.status !== body.status || o.statusMessage !== message;
    });
    if (!changing.length) {
      throw new PublishError(400, version === null ? 'No changes to apply: all versions already have the requested status and message'
        : 'No changes to apply: status and message are already set to the provided values');
    }
    for (const r of changing) {
      const o = JSON.parse(r.official);
      o.status = body.status;
      if (message === undefined) delete o.statusMessage;
      else o.statusMessage = message;
      o.statusChangedAt = nowIso;
      o.updatedAt = nowIso;
      await tx.run('UPDATE records SET official = ?, changed_at = ? WHERE name = ? AND version = ?', [JSON.stringify(o), nowIso, name, r.version]);
    }
    await recomputeLatest(tx, name, nowIso);
    const versions = changing.map((r) => r.version);
    return {rows: await tx.all(`SELECT ${ROW_COLUMNS} FROM records WHERE name = ? AND version IN (${versions.map(() => '?').join(', ')}) ORDER BY version`, [name, ...versions])};
  });
}

// PUT .../records/{name}/versions/{version} (8.4): -> {status: 201 | 200, sha256}.
async function putRecord(store, name, version, body, {claims, now = new Date()}) {
  if (!claimOf(name, claims)) throw notClaimed(name);
  if (isObject(body) && Array.isArray(body.tools) && body.tools.length > MAX_TOOLS) throw new PublishError(413, `A record holds at most ${MAX_TOOLS} tools`);
  const checked = validateRecord(body);
  if (!checked.valid) throw new PublishError(422, 'The record is not a valid countinghouse record', {errors: checked.errors});
  const sha256 = recordHash(body);
  return store.write(async (tx) => {
    const stored = await tx.get('SELECT sha256 FROM ch_records WHERE name = ? AND version = ?', [name, version]);
    if (stored) {
      if (stored.sha256 === sha256) return {status: 200, sha256};
      throw new PublishError(409, `A different record is stored for ${name}@${version}; records are immutable`);
    }
    await tx.run('INSERT INTO ch_records (name, version, body, sha256, record_version, at) VALUES (?, ?, ?, ?, ?, ?)',
      [name, version, JSON.stringify(body), sha256, body.recordVersion, now.toISOString()]);
    return {status: 201, sha256};
  });
}

module.exports = {publishServer, setStatus, putRecord, decodeProblem, PublishError, MAX_TOOLS};
