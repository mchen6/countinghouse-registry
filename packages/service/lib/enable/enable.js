'use strict';
// Enable through countinghouse (spec section 9): an operator enables a remote
// entry on a gateway instance, the instance polls its enabled list by change
// sequence and posts what it found. One store.write per operation; every change
// an instance must see takes tx.nextSeq() onto the affected enables row, so a
// poll (seq > since, in sequence order, on the read connection) is exact.
const Ajv2020 = require('ajv/dist/2020');
const {sha256Canonical} = require('countinghouse-registry-cli/lib/canonical-json');
const resultsSchema = require('./results.schema.json');

const MAX_TOOLS = 500;
const validateResult = new Ajv2020({allErrors: true, strict: false}).compile(resultsSchema);

class EnableError extends Error {
  constructor(status, detail, extra = {}) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.extra = extra;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const subject = (instance, name, version) => `${instance} ${name}@${version}`;

// The columns of an entry as an instance or an operator sees it.
// A local record's status is upstream's when an upstream copy has that status
// with that statusChangedAt (compareWithLocal's overlay); otherwise it is the
// local publisher's. The hash is the current enable cycle's latest result's.
const ENTRY_SELECT = `SELECT e.instance, e.name, e.version, e.state, e.remote_index, e.seq, e.updated_at, e.by_key, e.requested_seq,
    r.source, r.server, r.official, r.origin, r.hidden_reason,
    (SELECT 1 FROM conflicts c WHERE c.name = e.name AND c.version = e.version AND c.ack_at IS NULL) AS open_conflict,
    (SELECT 1 FROM overrides o WHERE o.name = e.name AND o.version = e.version AND o.keep_deleted = 1) AS keep_deleted,
    (SELECT 1 FROM record_sources s WHERE s.name = e.name AND s.version = e.version AND s.hidden_reason IS NULL
       AND json_extract(s.official, '$.status') = json_extract(r.official, '$.status')
       AND json_extract(s.official, '$.statusChangedAt') = json_extract(r.official, '$.statusChangedAt')) AS status_from_upstream,
    (SELECT x.sha256 FROM results x WHERE x.instance = e.instance AND x.name = e.name AND x.version = e.version AND x.seq > e.requested_seq
       ORDER BY x.id DESC LIMIT 1) AS sha256
  FROM enables e LEFT JOIN records r ON r.name = e.name AND r.version = e.version`;

// Notices, computed from current state (9.4): upstream's status changes
// (a local record's own status carries none), a hidden record, an
// unacknowledged conflict, a changed tool list. keepDeleted silences the
// deleted and gone notices (7.3).
function noticesOf(row, status) {
  const notices = [];
  const upstream = row.source === 'mirror' || Boolean(row.status_from_upstream);
  if (upstream && status === 'deprecated') notices.push('upstream-deprecated');
  if (upstream && status === 'deleted' && !row.hidden_reason && !row.keep_deleted) notices.push('upstream-deleted');
  if (row.hidden_reason && !row.keep_deleted) notices.push('gone-upstream');
  if (row.open_conflict) notices.push('conflict');
  if (row.state === 'changed') notices.push('tools-changed');
  return notices;
}

function itemOf(row) {
  const server = row.server ? JSON.parse(row.server) : {};
  const official = row.official ? JSON.parse(row.official) : {};
  const status = row.hidden_reason ? 'deleted' : official.status;
  const item = {name: row.name, version: row.version, state: row.state, remote: (server.remotes || [])[row.remote_index] || null,
    status, notices: noticesOf(row, status)};
  if (row.sha256) item.sha256 = row.sha256;
  item.updatedAt = row.updated_at;
  return item;
}

// -> {items, nextSince}: this instance's entries changed after `since`, in
// sequence order (ties never split: one value lands on one row per instance).
async function pollEnabled(store, instance, since, limit) {
  const rows = await store.read(`${ENTRY_SELECT} WHERE e.instance = ? AND e.seq > ? ORDER BY e.seq, e.name, e.version LIMIT ?`, [instance, since, limit]);
  return {rows, items: rows.map(itemOf), nextSince: String(rows.length ? rows[rows.length - 1].seq : since)};
}

const resultView = (r) => {
  const v = {outcome: r.outcome};
  if (r.sha256) v.sha256 = r.sha256;
  if (r.reason) v.reason = r.reason;
  v.at = r.at;
  return v;
};

// The operator's listing: the instance's view plus the current result and the
// history of every entry.
async function operatorEnabled(store, instance, since, limit) {
  const {rows, items, nextSince} = await pollEnabled(store, instance, since, limit);
  for (const [i, row] of rows.entries()) {
    const history = (await store.read('SELECT outcome, sha256, reason, at FROM results WHERE instance = ? AND name = ? AND version = ? ORDER BY id',
      [instance, row.name, row.version])).map(resultView);
    items[i].result = history.length ? history[history.length - 1] : null;
    items[i].history = history;
  }
  return {items, nextSince};
}

// Per instance, for an operator read of a record (9.6).
async function hostingDetail(store, name, version) {
  const rows = await store.read(`${ENTRY_SELECT} WHERE e.name = ? AND e.version = ? ORDER BY e.instance`, [name, version]);
  const byInstance = rows.map((r) => {
    const item = itemOf(r);
    const v = {instance: r.instance, state: r.state};
    if (item.sha256) v.sha256 = item.sha256;
    v.updatedAt = r.updated_at;
    v.notices = item.notices;
    return v;
  });
  const instances = rows.filter((r) => r.state === 'validated').length;
  return {hosted: instances > 0, instances, byInstance};
}

function enableBodyProblem(body) {
  if (!isObject(body)) return [{message: 'expected object', location: 'body', value: body === undefined ? null : body}];
  const errors = Object.keys(body).filter((k) => k !== 'remote').map((k) => ({message: 'unexpected property', location: `body.${k}`, value: body}));
  if ('remote' in body && !(Number.isInteger(body.remote) && body.remote >= 0)) {
    errors.push({message: 'expected an integer >= 0 (an index into server.remotes)', location: 'body.remote', value: body.remote});
  }
  return errors;
}

// PUT .../instances/{instance}/enabled/{name}/versions/{version} (9.3).
async function enableEntry(store, {instance, name, version, body, actor, now}) {
  const bad = enableBodyProblem(body);
  if (bad.length) throw new EnableError(422, 'validation failed', {errors: bad});
  const at = now.toISOString();
  return store.write(async (tx) => {
    const rec = await tx.get('SELECT server, official, hidden_reason FROM records WHERE name = ? AND version = ?', [name, version]);
    if (!rec) throw new EnableError(404, 'Server version not found');
    if (await tx.get('SELECT 1 AS x FROM conflicts WHERE name = ? AND version = ? AND ack_at IS NULL', [name, version])) {
      throw new EnableError(409, `${name}@${version} has an unacknowledged conflict with an upstream copy; acknowledge it (or publish a new version) to enable it`);
    }
    const deleted = rec.hidden_reason || JSON.parse(rec.official).status === 'deleted';
    if (deleted && !(await tx.get('SELECT 1 AS x FROM overrides WHERE name = ? AND version = ? AND keep_deleted = 1', [name, version]))) {
      throw new EnableError(409, `${name}@${version} is deleted or gone upstream; set the keepDeleted override to enable it`);
    }
    const remotes = JSON.parse(rec.server).remotes || [];
    let index = body.remote;
    if (index === undefined) {
      index = remotes.findIndex((r) => r && r.type === 'streamable-http');
      if (index < 0) throw new EnableError(422, `${name}@${version} has no streamable-http remote (sse remotes are not enabled in version 1)`);
    } else if (!remotes[index] || remotes[index].type !== 'streamable-http') {
      throw new EnableError(422, `remote ${index} of ${name}@${version} is not a streamable-http remote`);
    }
    const seq = await tx.nextSeq();
    await tx.run(`INSERT INTO enables (instance, name, version, state, remote_index, seq, requested_seq, updated_at, by_key) VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?)
      ON CONFLICT (instance, name, version) DO UPDATE SET state = 'requested', remote_index = excluded.remote_index, seq = excluded.seq,
        requested_seq = excluded.requested_seq, updated_at = excluded.updated_at, by_key = excluded.by_key`, [instance, name, version, index, seq, seq, at, actor.fp]);
    await tx.run('INSERT INTO audit (at, key_fp, action, subject) VALUES (?, ?, ?, ?)', [at, actor.fp, 'enable', subject(instance, name, version)]);
    return {instance, name, version, state: 'requested', remote: remotes[index], updatedAt: at, by: actor.fp};
  });
}

// DELETE of the same path: disabled, kept so the instance sees it stop.
async function disableEntry(store, {instance, name, version, actor, now}) {
  const at = now.toISOString();
  return store.write(async (tx) => {
    const row = await tx.get(`SELECT e.*, r.server FROM enables e LEFT JOIN records r ON r.name = e.name AND r.version = e.version
      WHERE e.instance = ? AND e.name = ? AND e.version = ?`, [instance, name, version]);
    if (!row) throw new EnableError(404, `${instance} has no enable for ${name}@${version}`);
    const remote = row.server ? (JSON.parse(row.server).remotes || [])[row.remote_index] || null : null;
    if (row.state !== 'disabled') {
      const seq = await tx.nextSeq();
      await tx.run("UPDATE enables SET state = 'disabled', seq = ?, updated_at = ?, by_key = ? WHERE instance = ? AND name = ? AND version = ?",
        [seq, at, actor.fp, instance, name, version]);
      await tx.run('INSERT INTO audit (at, key_fp, action, subject) VALUES (?, ?, ?, ?)', [at, actor.fp, 'disable', subject(instance, name, version)]);
      return {instance, name, version, state: 'disabled', remote, updatedAt: at, by: actor.fp};
    }
    return {instance, name, version, state: 'disabled', remote, updatedAt: row.updated_at, by: row.by_key};
  });
}

const STATE_OF = {validated: 'validated', changed: 'changed', failed: 'failed'};

// POST .../instances/{instance}/results (9.4). -> {sha256} | {}.
async function postResult(store, {instance, body, now}) {
  if (isObject(body) && Array.isArray(body.tools) && body.tools.length > MAX_TOOLS) throw new EnableError(413, `A result holds at most ${MAX_TOOLS} tools`);
  if (!validateResult(body)) {
    const errors = validateResult.errors.map((e) => ({message: e.message, location: `body${e.instancePath.replace(/\//g, '.')}`,
      ...(e.params && e.params.additionalProperty ? {value: e.params.additionalProperty} : {})}));
    throw new EnableError(422, 'validation failed', {errors});
  }
  const {name, version, outcome, reason, previousSha256} = body;
  // The contract hash (docs/api.md): sha256Canonical({tools}), hex.
  const sha256 = outcome === 'failed' ? null : sha256Canonical({tools: body.tools});
  const at = now.toISOString();
  const answer = sha256 ? {sha256} : {};
  return store.write(async (tx) => {
    const entry = await tx.get('SELECT state, requested_seq FROM enables WHERE instance = ? AND name = ? AND version = ?', [instance, name, version]);
    if (!entry || entry.state === 'disabled') throw new EnableError(409, `${name}@${version} is not enabled for ${instance}`);
    // A result equal to one already accepted in this enable cycle (a repeat, or
    // the gateway's late retry of an earlier one) is 200 and changes nothing.
    const repeat = await tx.get(`SELECT 1 AS x FROM results WHERE instance = ? AND name = ? AND version = ? AND seq > ? AND outcome = ?
      AND sha256 IS ? AND reason IS ? AND previous_sha256 IS ?`, [instance, name, version, entry.requested_seq, outcome, sha256, reason || null, previousSha256 || null]);
    if (repeat) return answer;
    const current = await tx.get('SELECT outcome, sha256, reason FROM results WHERE instance = ? AND name = ? AND version = ? AND seq > ? ORDER BY id DESC LIMIT 1',
      [instance, name, version, entry.requested_seq]);
    if (outcome === 'validated' && entry.state !== 'requested') {
      throw new EnableError(409, `validated is accepted for an entry in state requested; ${name}@${version} is ${entry.state}`);
    }
    if (outcome === 'changed') {
      if (entry.state !== 'validated' && entry.state !== 'changed') {
        throw new EnableError(409, `changed is accepted for an entry in state validated; ${name}@${version} is ${entry.state}`);
      }
      // previousSha256 is the hash the gateway serves against: the validated one,
      // or (a newer list while changed) the current changed one.
      if (!current || previousSha256 !== current.sha256) {
        throw new EnableError(409, `previousSha256 is not the current hash of ${name}@${version}`);
      }
    }
    const seq = await tx.nextSeq();
    await tx.run(`INSERT INTO results (instance, name, version, outcome, sha256, previous_sha256, reason, tools, at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [instance, name, version, outcome, sha256, previousSha256 || null, reason || null,
      body.tools ? JSON.stringify(body.tools) : null, at, seq]);
    await tx.run('UPDATE enables SET state = ?, seq = ?, updated_at = ? WHERE instance = ? AND name = ? AND version = ?',
      [STATE_OF[outcome], seq, at, instance, name, version]);
    return answer;
  });
}

// At startup: the entries of an instance no longer in config are disabled (its
// key is gone, so it can neither poll nor be counted as hosting). -> the
// instances whose entries were disabled.
async function applyInstances(store, configured, nowIso) {
  return store.write(async (tx) => {
    const marks = configured.map(() => '?').join(', ');
    const rows = await tx.all(`SELECT instance, name, version FROM enables WHERE state <> 'disabled'
      ${configured.length ? `AND instance NOT IN (${marks})` : ''} ORDER BY instance, name, version`, configured);
    for (const r of rows) {
      const seq = await tx.nextSeq();
      await tx.run("UPDATE enables SET state = 'disabled', seq = ?, updated_at = ?, by_key = 'config' WHERE instance = ? AND name = ? AND version = ?",
        [seq, nowIso, r.instance, r.name, r.version]);
      await tx.run("INSERT INTO audit (at, key_fp, action, subject) VALUES (?, 'config', 'disable', ?)", [nowIso, subject(r.instance, r.name, r.version)]);
    }
    return [...new Set(rows.map((r) => r.instance))];
  });
}

module.exports = {applyInstances, enableEntry, disableEntry, postResult, pollEnabled, operatorEnabled, hostingDetail, EnableError, MAX_TOOLS};
