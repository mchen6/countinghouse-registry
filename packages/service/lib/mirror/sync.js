'use strict';
// Mirroring the official catalogue (spec section 6).
//
// One run reads pages of GET /v0.1/servers and applies each page in its own write
// transaction, recording the next cursor with it, so a run interrupted anywhere
// (a crash, a stop request, an upstream failure) resumes from the next unapplied
// page. Three kinds of run:
//   first        the initial full sync; its start time becomes the checkpoint,
//                committed only after the last page
//   incremental  updated_since = checkpoint - 5 minutes, the same on every page
//   reconcile    a full pass; mirrored records it does not see are hidden as
//                gone-upstream, unless it saw fewer than half the previous
//                pass's records (an upstream reset: nothing is hidden)
// Mirrored records are stored as served, never validated (spec 6.7), and a local
// record is never overwritten here.

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const OVERLAP_MS = 5 * 60 * 1000;

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

async function readState(db) {
  const [st] = await db('SELECT * FROM mirror_state WHERE id = 1');
  const kv = Object.fromEntries((await db("SELECT k, v FROM meta_kv WHERE k LIKE 'mirror_%'")).map((r) => [r.k, r.v]));
  return {...st, runMode: kv.mirror_run_mode || null, successStarted: kv.mirror_success_started || null};
}

async function setKv(tx, k, v) {
  if (v === null) await tx.run('DELETE FROM meta_kv WHERE k = ?', [k]);
  else await tx.run('INSERT INTO meta_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]);
}

async function upsert(tx, r, nowIso, passNo) {
  const server = JSON.stringify(r.server);
  const official = JSON.stringify(r._meta[OFFICIAL]);
  const updatedAt = r._meta[OFFICIAL].updatedAt || null;
  const existing = await tx.get('SELECT source, server, official, upstream_updated_at, hidden_reason FROM records WHERE name = ? AND version = ?',
    [r.server.name, r.server.version]);
  if (!existing) {
    await tx.run(`INSERT INTO records (source, name, version, server, official, origin, changed_at, mirrored_at, upstream_updated_at, seen_pass)
                  VALUES ('mirror', ?, ?, ?, ?, 'mirror', ?, ?, ?, ?)`,
    [r.server.name, r.server.version, server, official, nowIso, nowIso, updatedAt, passNo]);
    return;
  }
  if (existing.source === 'local') return;
  const stale = existing.upstream_updated_at && updatedAt && isOlder(updatedAt, existing.upstream_updated_at);
  const same = existing.server === server && existing.official === official;
  if (stale || same) {
    if (existing.hidden_reason) {
      await tx.run('UPDATE records SET seen_pass = ?, hidden_reason = NULL, changed_at = ? WHERE name = ? AND version = ?',
        [passNo, nowIso, r.server.name, r.server.version]);
    } else {
      await tx.run('UPDATE records SET seen_pass = ? WHERE name = ? AND version = ?', [passNo, r.server.name, r.server.version]);
    }
    return;
  }
  await tx.run(`UPDATE records SET server = ?, official = ?, upstream_updated_at = ?, changed_at = ?, mirrored_at = ?, seen_pass = ?, hidden_reason = NULL
                WHERE name = ? AND version = ?`,
  [server, official, updatedAt, nowIso, nowIso, passNo, r.server.name, r.server.version]);
}

async function fail(store, log, code, extra) {
  await store.write((tx) => tx.run("UPDATE mirror_state SET state = 'failed', last_error = ? WHERE id = 1", [code]));
  log.error('mirror.failed', 'a mirror run failed', {code, ...extra});
  return {state: 'failed'};
}

async function runSync(store, client, log, {mode = null, now = () => new Date(), shouldStop = () => false} = {}) {
  let st = await readState((sql, p) => store.read(sql, p));
  const resuming = st.run_started_at !== null;
  const runMode = resuming ? st.runMode : (!st.first_sync_done ? 'first' : (mode || 'incremental'));
  const start = resuming ? st.run_started_at : now().toISOString();
  const passNo = resuming ? st.pass_no : (runMode === 'incremental' ? st.pass_no : st.pass_no + 1);
  if (!resuming) {
    await store.write(async (tx) => {
      await tx.run("UPDATE mirror_state SET run_started_at = ?, cursor = NULL, state = 'syncing', pass_no = ? WHERE id = 1", [start, passNo]);
      await setKv(tx, 'mirror_run_mode', runMode);
    });
  } else {
    await store.write((tx) => tx.run("UPDATE mirror_state SET state = 'syncing' WHERE id = 1"));
  }

  const upstreamVersion = await client.version();
  if (upstreamVersion) await store.write((tx) => tx.run('UPDATE mirror_state SET upstream_version = ? WHERE id = 1', [upstreamVersion]));

  st = await readState((sql, p) => store.read(sql, p));
  const updatedSince = runMode === 'incremental' ? new Date(Date.parse(st.checkpoint) - OVERLAP_MS).toISOString() : null;
  let cursor = st.cursor;
  let pageNo = 0;
  for (;;) {
    if (shouldStop()) return {state: 'syncing'};
    pageNo++;
    let page;
    try {
      page = await client.page({cursor, updatedSince});
    } catch (err) {
      return fail(store, log, err.code || 'network', {status: err.status || null, page: pageNo, mode: runMode});
    }
    const nowIso = now().toISOString();
    await store.write(async (tx) => {
      for (const r of page.servers) await upsert(tx, r, nowIso, passNo);
      await tx.run('UPDATE mirror_state SET cursor = ? WHERE id = 1', [page.nextCursor]);
    });
    log.debug('mirror.page', 'applied one page', {page: pageNo, count: page.servers.length, mode: runMode});
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const nowIso = now().toISOString();
  if (runMode !== 'incremental') {
    const [{n}] = await store.read("SELECT count(*) AS n FROM records WHERE source = 'mirror' AND seen_pass = ?", [passNo]);
    if (runMode === 'reconcile' && st.last_pass_count && n < st.last_pass_count / 2) {
      await store.write(async (tx) => {
        await tx.run('UPDATE mirror_state SET run_started_at = NULL, cursor = NULL WHERE id = 1');
        await setKv(tx, 'mirror_run_mode', null);
      });
      return fail(store, log, 'upstream-shrank', {seen: n, previous: st.last_pass_count});
    }
    await store.write(async (tx) => {
      if (runMode === 'reconcile') {
        await tx.run(`UPDATE records SET hidden_reason = 'gone-upstream', changed_at = ?
                      WHERE source = 'mirror' AND hidden_reason IS NULL AND (seen_pass IS NULL OR seen_pass <> ?)`, [nowIso, passNo]);
      }
      await tx.run('UPDATE mirror_state SET last_pass_count = ?, last_reconcile_at = ? WHERE id = 1', [n, nowIso]);
    });
  }
  await store.write(async (tx) => {
    await tx.run(`UPDATE mirror_state SET checkpoint = ?, run_started_at = NULL, cursor = NULL, first_sync_done = 1,
                  state = 'idle', last_error = NULL, last_success_at = ? WHERE id = 1`, [start, nowIso]);
    await setKv(tx, 'mirror_run_mode', null);
    await setKv(tx, 'mirror_success_started', start);
  });
  log.info('mirror.done', 'a mirror run finished', {mode: runMode, pages: pageNo});
  return {state: 'idle'};
}

async function mirrorState(store, now = new Date()) {
  const st = await readState((sql, p) => store.read(sql, p));
  return {
    state: st.state,
    lastSuccessAt: st.last_success_at || null,
    lag: st.successStarted ? Math.floor((now.getTime() - Date.parse(st.successStarted)) / 1000) : null,
    lastError: st.last_error || null,
    upstreamVersion: st.upstream_version || null
  };
}

module.exports = {runSync, mirrorState};
