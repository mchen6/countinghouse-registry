'use strict';
// Mirroring the official catalogue (spec section 6).
//
// One run reads pages of GET /v0.1/servers. Each page is applied in its own write
// transaction together with the next cursor, and the last page's transaction also
// marks the pages done, so a run interrupted anywhere (a crash, a stop, an
// upstream or store failure) resumes from the next unapplied step: the next page,
// or the finishing step. Three kinds of run:
//   first        the initial full sync; its start time becomes the checkpoint,
//                committed only when the run finishes
//   incremental  updated_since = checkpoint - 5 minutes, the same on every page
//   reconcile    a full pass; what it sees is staged, and applied only after the
//                shrink guard: if it saw fewer than half the previous pass's
//                records (an upstream reset) nothing is applied and the pass is
//                retried the next day; otherwise the staged records are applied
//                and mirrored records it did not see are hidden as gone-upstream.
//                The guard is decided once: the first apply transaction records
//                it, so a run resumed mid-apply (fewer rows left staged) goes on
//                applying instead of judging the remainder as a shrink
// Mirrored records are stored as served, never validated (spec 6.7), and a local
// record is never overwritten here.

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

async function readState(read) {
  const [st] = await read('SELECT * FROM mirror_state WHERE id = 1');
  const kv = Object.fromEntries((await read("SELECT k, v FROM meta_kv WHERE k LIKE 'mirror_%'")).map((r) => [r.k, r.v]));
  return {...st, runMode: kv.mirror_run_mode || null, successStarted: kv.mirror_success_started || null, pagesDone: kv.mirror_pages_done === '1',
    guardPassed: (kv.mirror_reconcile_guard || '').startsWith('passed')};
}

async function setKv(tx, k, v) {
  if (v === null) await tx.run('DELETE FROM meta_kv WHERE k = ?', [k]);
  else await tx.run('INSERT INTO meta_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]);
}

// Applies one upstream record. `server` and `official` are JSON text.
async function upsert(tx, name, version, server, official, nowIso, passNo) {
  const updatedAt = JSON.parse(official).updatedAt || null;
  const existing = await tx.get('SELECT source, server, official, upstream_updated_at, hidden_reason FROM records WHERE name = ? AND version = ?', [name, version]);
  if (!existing) {
    await tx.run(`INSERT INTO records (source, name, version, server, official, origin, changed_at, mirrored_at, upstream_updated_at, seen_pass)
                  VALUES ('mirror', ?, ?, ?, ?, 'mirror', ?, ?, ?, ?)`, [name, version, server, official, nowIso, nowIso, updatedAt, passNo]);
    return;
  }
  if (existing.source === 'local') return;
  const stale = existing.upstream_updated_at && updatedAt && isOlder(updatedAt, existing.upstream_updated_at);
  const keep = stale || (existing.server === server && existing.official === official);
  if (keep && !existing.hidden_reason) {
    await tx.run('UPDATE records SET seen_pass = ? WHERE name = ? AND version = ?', [passNo, name, version]);
    return;
  }
  // A changed copy, or a hidden record seen again: either way it changes here.
  await tx.run(`UPDATE records SET server = ?, official = ?, upstream_updated_at = ?, changed_at = ?, mirrored_at = ?, seen_pass = ?, hidden_reason = NULL
                WHERE name = ? AND version = ?`,
  keep ? [existing.server, existing.official, existing.upstream_updated_at, nowIso, nowIso, passNo, name, version]
    : [server, official, updatedAt, nowIso, nowIso, passNo, name, version]);
}

// The next UTC day's reconcile hour, as an ISO string.
function nextDaySlot(now, atHour) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), atHour));
  return new Date(d.getTime() + DAY_MS).toISOString();
}

async function fail(store, log, code, extra) {
  await store.write((tx) => tx.run("UPDATE mirror_state SET state = 'failed', last_error = ? WHERE id = 1", [code])).catch(() => {});
  log.error('mirror.failed', 'a mirror run failed', {code, ...extra});
  return {state: 'failed'};
}

async function applyPage(store, page, runMode, passNo, nowIso) {
  await store.write(async (tx) => {
    for (const r of page.servers) {
      const server = JSON.stringify(r.server);
      const official = JSON.stringify(r._meta[OFFICIAL]);
      if (runMode === 'reconcile') {
        await tx.run(`INSERT INTO reconcile_stage (pass_no, name, version, server, official) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT (pass_no, name, version) DO UPDATE SET server = excluded.server, official = excluded.official`,
        [passNo, r.server.name, r.server.version, server, official]);
      } else {
        await upsert(tx, r.server.name, r.server.version, server, official, nowIso, passNo);
      }
    }
    await tx.run('UPDATE mirror_state SET cursor = ? WHERE id = 1', [page.nextCursor]);
    if (!page.nextCursor) await setKv(tx, 'mirror_pages_done', '1');
  });
}

async function finish(store, log, st, runMode, start, passNo, now, atHour, applyBatch) {
  const nowIso = now().toISOString();
  if (runMode === 'reconcile') {
    const [{n}] = await store.read('SELECT count(*) AS n FROM reconcile_stage WHERE pass_no = ?', [passNo]);
    if (!st.guardPassed && st.last_pass_count && n < st.last_pass_count / 2) {
      await store.write(async (tx) => {
        await tx.run('DELETE FROM reconcile_stage WHERE pass_no = ?', [passNo]);
        await tx.run('UPDATE mirror_state SET run_started_at = NULL, cursor = NULL WHERE id = 1');
        await setKv(tx, 'mirror_run_mode', null);
        await setKv(tx, 'mirror_pages_done', null);
        await setKv(tx, 'mirror_reconcile_retry_at', nextDaySlot(now(), atHour));
      });
      return fail(store, log, 'upstream-shrank', {seen: n, previous: st.last_pass_count});
    }
    // Apply the staged pass in page-sized transactions, then hide what it did not see.
    for (;;) {
      const batch = await store.read('SELECT name, version, server, official FROM reconcile_stage WHERE pass_no = ? LIMIT ?', [passNo, applyBatch]);
      if (!batch.length) break;
      await store.write(async (tx) => {
        if (!st.guardPassed) await setKv(tx, 'mirror_reconcile_guard', `passed:${n}`);
        for (const r of batch) {
          await upsert(tx, r.name, r.version, r.server, r.official, nowIso, passNo);
          await tx.run('DELETE FROM reconcile_stage WHERE pass_no = ? AND name = ? AND version = ?', [passNo, r.name, r.version]);
        }
      });
    }
    await store.write((tx) => tx.run(`UPDATE records SET hidden_reason = 'gone-upstream', changed_at = ?
      WHERE source = 'mirror' AND hidden_reason IS NULL AND (seen_pass IS NULL OR seen_pass <> ?)`, [nowIso, passNo]));
  }
  await store.write(async (tx) => {
    if (runMode !== 'incremental') {
      const {n} = await tx.get("SELECT count(*) AS n FROM records WHERE source = 'mirror' AND seen_pass = ?", [passNo]);
      await tx.run('UPDATE mirror_state SET last_pass_count = ?, last_reconcile_at = ? WHERE id = 1', [n, nowIso]);
      await setKv(tx, 'mirror_reconcile_retry_at', null);
      await setKv(tx, 'mirror_reconcile_guard', null);
    }
    await tx.run(`UPDATE mirror_state SET checkpoint = ?, run_started_at = NULL, cursor = NULL, first_sync_done = 1,
                  state = 'idle', last_error = NULL, last_success_at = ? WHERE id = 1`, [start, nowIso]);
    await setKv(tx, 'mirror_run_mode', null);
    await setKv(tx, 'mirror_pages_done', null);
    await setKv(tx, 'mirror_success_started', start);
  });
  log.info('mirror.done', 'a mirror run finished', {mode: runMode});
  return {state: 'idle'};
}

async function runSync(store, client, log, {mode = null, now = () => new Date(), signal = null, shouldStop = () => false, atHour = 3, applyBatch = 100} = {}) {
  const stopping = () => (signal && signal.aborted) || shouldStop();
  let runMode = mode;
  try {
    let st = await readState(store.read);
    const resuming = st.run_started_at !== null;
    runMode = resuming ? st.runMode : (!st.first_sync_done ? 'first' : (mode || 'incremental'));
    const start = resuming ? st.run_started_at : now().toISOString();
    const passNo = resuming ? st.pass_no : (runMode === 'incremental' ? st.pass_no : st.pass_no + 1);
    await store.write(async (tx) => {
      if (!resuming) {
        await tx.run('UPDATE mirror_state SET run_started_at = ?, cursor = NULL, pass_no = ? WHERE id = 1', [start, passNo]);
        await setKv(tx, 'mirror_run_mode', runMode);
        await setKv(tx, 'mirror_pages_done', null);
        if (runMode === 'reconcile') {
          // A pass abandoned earlier leaves neither its rows nor its guard decision behind.
          await tx.run('DELETE FROM reconcile_stage WHERE pass_no <> ?', [passNo]);
          await setKv(tx, 'mirror_reconcile_guard', null);
        }
      }
      await tx.run("UPDATE mirror_state SET state = 'syncing' WHERE id = 1");
    });

    const upstreamVersion = await client.version({signal});
    if (upstreamVersion) await store.write((tx) => tx.run('UPDATE mirror_state SET upstream_version = ? WHERE id = 1', [upstreamVersion]));

    st = await readState(store.read);
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
        return fail(store, log, err.code || 'network', {status: err.status || null, page: pageNo, mode: runMode});
      }
      await applyPage(store, page, runMode, passNo, now().toISOString());
      log.debug('mirror.page', 'applied one page', {page: pageNo, count: page.servers.length, mode: runMode});
      st = {...st, cursor: page.nextCursor, pagesDone: !page.nextCursor};
    }
    return await finish(store, log, st, runMode, start, passNo, now, atHour, applyBatch);
  } catch (err) {
    return fail(store, log, 'store', {cause: err.code || err.name, mode: runMode});
  }
}

async function mirrorState(store, now = new Date()) {
  const st = await readState(store.read);
  return {
    state: st.state,
    lastSuccessAt: st.last_success_at || null,
    lag: st.successStarted ? Math.floor((now.getTime() - Date.parse(st.successStarted)) / 1000) : null,
    lastError: st.last_error || null,
    upstreamVersion: st.upstream_version || null
  };
}

module.exports = {runSync, mirrorState};
