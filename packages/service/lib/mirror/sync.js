'use strict';
// Mirroring one upstream (spec section 6; several upstreams, 6.8).
//
// One run reads pages of the upstream's GET /v0.1/servers. Each page is applied in
// its own write transaction together with the next cursor, and the last page's
// transaction also marks the pages done, so a run interrupted anywhere (a crash, a
// stop, an upstream or store failure) resumes from the next unapplied step: the
// next page, or the finishing step. Three kinds of run:
//   first        the initial full sync; its start time becomes the checkpoint,
//                committed only when the run finishes
//   incremental  updated_since = checkpoint - 5 minutes, the same on every page
//   reconcile    a full pass; what it sees is staged, and applied only after the
//                shrink guard: if it saw fewer than half the previous pass's
//                records (an upstream reset) nothing is applied and the pass is
//                retried the next day; otherwise the staged records are applied
//                and this upstream's copies it did not see are marked
//                gone-upstream. The guard is decided once: the first apply
//                transaction records it, so a run resumed mid-apply (fewer rows
//                left staged) goes on applying instead of judging the remainder
//                as a shrink
// Copies are stored as served, never validated (spec 6.7), in record_sources; every
// write that changes a copy rebuilds the served records of its name in the same
// transaction (sources.js). State, cursor, checkpoint, pass count and guard are
// the upstream's own row of mirror_upstreams.
const {rebuildNames} = require('./sources');

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const OVERLAP_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600000;

// Upstream timestamps carry microseconds; compare them exactly.
function timeKey(s) {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  const m = /\.(\d+)/.exec(s);
  const frac = m ? m[1].padEnd(9, '0').slice(3, 9) : '000000';
  return [ms, Number(frac)];
}

function isOlder(incoming, stored) {
  const a = timeKey(incoming);
  const b = timeKey(stored);
  if (!a || !b) return false;
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

async function readState(read, upstream) {
  const [st] = await read('SELECT * FROM mirror_upstreams WHERE name = ?', [upstream]);
  if (!st) throw Object.assign(new Error(`unknown upstream ${upstream}`), {code: 'unknown-upstream'});
  return {...st, pagesDone: st.pages_done === 1, guardPassed: (st.reconcile_guard || '').startsWith('passed')};
}

function setState(tx, upstream, fields) {
  const keys = Object.keys(fields);
  return tx.run(`UPDATE mirror_upstreams SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE name = ?`, [...keys.map((k) => fields[k]), upstream]);
}

// Stores one upstream copy. `server` and `official` are JSON text. Returns true
// when the copy changed (so its name's served records need a rebuild).
async function upsertCopy(tx, upstream, name, version, server, official, nowIso, passNo) {
  const updatedAt = JSON.parse(official).updatedAt || null;
  const existing = await tx.get('SELECT server, official, upstream_updated_at, hidden_reason FROM record_sources WHERE upstream = ? AND name = ? AND version = ?',
    [upstream, name, version]);
  if (!existing) {
    await tx.run(`INSERT INTO record_sources (upstream, name, version, server, official, upstream_updated_at, mirrored_at, seen_pass)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [upstream, name, version, server, official, updatedAt, nowIso, passNo]);
    return true;
  }
  const stale = existing.upstream_updated_at && updatedAt && isOlder(updatedAt, existing.upstream_updated_at);
  const keep = stale || (existing.server === server && existing.official === official);
  if (keep && !existing.hidden_reason) {
    await tx.run('UPDATE record_sources SET seen_pass = ? WHERE upstream = ? AND name = ? AND version = ?', [passNo, upstream, name, version]);
    return false;
  }
  // A changed copy, or a gone-upstream copy seen again: either way it changes here.
  await tx.run(`UPDATE record_sources SET server = ?, official = ?, upstream_updated_at = ?, mirrored_at = ?, seen_pass = ?, hidden_reason = NULL
                WHERE upstream = ? AND name = ? AND version = ?`,
  keep ? [existing.server, existing.official, existing.upstream_updated_at, nowIso, passNo, upstream, name, version]
    : [server, official, updatedAt, nowIso, passNo, upstream, name, version]);
  return true;
}

// The next UTC day's reconcile hour, as an ISO string.
function nextDaySlot(now, atHour) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), atHour));
  return new Date(d.getTime() + DAY_MS).toISOString();
}

async function fail(store, log, upstream, code, extra) {
  await store.write((tx) => setState(tx, upstream, {state: 'failed', last_error: code})).catch(() => {});
  log.error('mirror.failed', 'a mirror run failed', {upstream, code, ...extra});
  return {state: 'failed'};
}

async function applyPage(store, upstream, page, runMode, passNo, nowIso) {
  await store.write(async (tx) => {
    const changed = [];
    for (const r of page.servers) {
      const server = JSON.stringify(r.server);
      const official = JSON.stringify(r._meta[OFFICIAL]);
      if (runMode === 'reconcile') {
        await tx.run(`INSERT INTO reconcile_stage (upstream, pass_no, name, version, server, official) VALUES (?, ?, ?, ?, ?, ?)
                      ON CONFLICT (upstream, pass_no, name, version) DO UPDATE SET server = excluded.server, official = excluded.official`,
        [upstream, passNo, r.server.name, r.server.version, server, official]);
      } else if (await upsertCopy(tx, upstream, r.server.name, r.server.version, server, official, nowIso, passNo)) {
        changed.push(r.server.name);
      }
    }
    await rebuildNames(tx, changed, nowIso);
    await setState(tx, upstream, page.nextCursor ? {cursor: page.nextCursor} : {cursor: null, pages_done: 1});
  });
}

async function finish(store, log, upstream, st, runMode, start, passNo, now, atHour, applyBatch) {
  const nowIso = now().toISOString();
  if (runMode === 'reconcile') {
    const [{n}] = await store.read('SELECT count(*) AS n FROM reconcile_stage WHERE upstream = ? AND pass_no = ?', [upstream, passNo]);
    if (!st.guardPassed && st.last_pass_count && n < st.last_pass_count / 2) {
      await store.write(async (tx) => {
        await tx.run('DELETE FROM reconcile_stage WHERE upstream = ? AND pass_no = ?', [upstream, passNo]);
        await setState(tx, upstream, {run_started_at: null, cursor: null, run_mode: null, pages_done: 0,
          reconcile_retry_at: nextDaySlot(now(), atHour)});
      });
      return fail(store, log, upstream, 'upstream-shrank', {seen: n, previous: st.last_pass_count});
    }
    // Apply the staged pass in batches, then mark what it did not see.
    for (;;) {
      const batch = await store.read('SELECT name, version, server, official FROM reconcile_stage WHERE upstream = ? AND pass_no = ? LIMIT ?',
        [upstream, passNo, applyBatch]);
      if (!batch.length) break;
      await store.write(async (tx) => {
        if (!st.guardPassed) await setState(tx, upstream, {reconcile_guard: `passed:${n}`});
        const changed = [];
        for (const r of batch) {
          if (await upsertCopy(tx, upstream, r.name, r.version, r.server, r.official, nowIso, passNo)) changed.push(r.name);
          await tx.run('DELETE FROM reconcile_stage WHERE upstream = ? AND pass_no = ? AND name = ? AND version = ?', [upstream, passNo, r.name, r.version]);
        }
        await rebuildNames(tx, changed, nowIso);
      });
    }
    await store.write(async (tx) => {
      const gone = await tx.all(`UPDATE record_sources SET hidden_reason = 'gone-upstream'
        WHERE upstream = ? AND hidden_reason IS NULL AND (seen_pass IS NULL OR seen_pass <> ?) RETURNING name`, [upstream, passNo]);
      await rebuildNames(tx, gone.map((g) => g.name), nowIso);
    });
  }
  await store.write(async (tx) => {
    if (runMode !== 'incremental') {
      const {n} = await tx.get('SELECT count(*) AS n FROM record_sources WHERE upstream = ? AND seen_pass = ?', [upstream, passNo]);
      await setState(tx, upstream, {last_pass_count: n, last_reconcile_at: nowIso, reconcile_retry_at: null, reconcile_guard: null});
    }
    await setState(tx, upstream, {checkpoint: start, run_started_at: null, cursor: null, first_sync_done: 1, state: 'idle',
      last_error: null, last_success_at: nowIso, run_mode: null, pages_done: 0, success_started: start});
  });
  log.info('mirror.done', 'a mirror run finished', {upstream, mode: runMode});
  return {state: 'idle'};
}

async function runSync(store, client, log, {upstream = 'official', mode = null, now = () => new Date(), signal = null,
  shouldStop = () => false, atHour = 3, applyBatch = 100} = {}) {
  const stopping = () => (signal && signal.aborted) || shouldStop();
  let runMode = mode;
  try {
    let st = await readState(store.read, upstream);
    const resuming = st.run_started_at !== null;
    runMode = resuming ? st.run_mode : (!st.first_sync_done ? 'first' : (mode || 'incremental'));
    const start = resuming ? st.run_started_at : now().toISOString();
    const passNo = resuming ? st.pass_no : (runMode === 'incremental' ? st.pass_no : st.pass_no + 1);
    await store.write(async (tx) => {
      if (!resuming) {
        await setState(tx, upstream, {run_started_at: start, cursor: null, pass_no: passNo, run_mode: runMode, pages_done: 0});
        if (runMode === 'reconcile') {
          // A pass abandoned earlier leaves neither its rows nor its guard decision behind.
          await tx.run('DELETE FROM reconcile_stage WHERE upstream = ? AND pass_no <> ?', [upstream, passNo]);
          await setState(tx, upstream, {reconcile_guard: null});
        }
      }
      await setState(tx, upstream, {state: 'syncing'});
    });

    const upstreamVersion = await client.version({signal});
    if (upstreamVersion) await store.write((tx) => setState(tx, upstream, {upstream_version: upstreamVersion}));

    st = await readState(store.read, upstream);
    const updatedSince = runMode === 'incremental' ? new Date(Date.parse(st.checkpoint) - OVERLAP_MS).toISOString() : null;
    let pageNo = 0;
    while (!st.pagesDone) {
      if (stopping()) return {state: 'syncing'};
      pageNo++;
      let page;
      try {
        page = await client.page({cursor: st.cursor, updatedSince, signal});
      } catch (err) {
        if (err.code === 'aborted') return {state: 'syncing'};
        return fail(store, log, upstream, err.code || 'network', {status: err.status || null, page: pageNo, mode: runMode});
      }
      await applyPage(store, upstream, page, runMode, passNo, now().toISOString());
      log.debug('mirror.page', 'applied one page', {upstream, page: pageNo, count: page.servers.length, mode: runMode});
      st = {...st, cursor: page.nextCursor, pagesDone: !page.nextCursor};
    }
    return await finish(store, log, upstream, st, runMode, start, passNo, now, atHour, applyBatch);
  } catch (err) {
    return fail(store, log, upstream, 'store', {cause: err.code || err.name, mode: runMode});
  }
}

const RANK = {idle: 0, syncing: 1, failed: 2};

// Every configured upstream's state, in precedence order (internal: /healthz and
// operator reads, since an upstream's name is the operator's topology).
async function mirrorState(store, now = new Date()) {
  const rows = await store.read('SELECT * FROM mirror_upstreams ORDER BY position');
  return {
    upstreams: rows.map((st) => ({
      name: st.name,
      state: st.state,
      lastSuccessAt: st.last_success_at || null,
      lag: st.success_started ? Math.floor((now.getTime() - Date.parse(st.success_started)) / 1000) : null,
      lastError: st.last_error || null,
      upstreamVersion: st.upstream_version || null
    }))
  };
}

// The public aggregate: the worst state, the oldest success, the largest lag and
// how many upstreams, so a reader knows the catalogue may be partial without
// learning what it is assembled from. Each is null while any upstream's own is
// (one that has never succeeded, or whose lag is unknown).
function mirrorSummary({upstreams}) {
  const known = (k) => upstreams.length > 0 && upstreams.every((u) => u[k] !== null);
  return {
    state: upstreams.reduce((w, u) => (RANK[u.state] > RANK[w] ? u.state : w), 'idle'),
    lastSuccessAt: known('lastSuccessAt') ? upstreams.map((u) => u.lastSuccessAt).sort()[0] : null,
    lag: known('lag') ? Math.max(...upstreams.map((u) => u.lag)) : null,
    upstreams: upstreams.length
  };
}

module.exports = {runSync, mirrorState, mirrorSummary};
