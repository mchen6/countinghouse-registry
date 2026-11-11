'use strict';
// Several upstreams (spec section 6.8). Every upstream's copy of a name@version is
// kept in record_sources; the served mirrored records are a projection of them,
// rebuilt per name inside the write transaction that changed a copy:
//   - the copy of the first upstream in the list that still has it (not
//     gone-upstream) is served, a deleted copy included;
//   - a record no upstream has any more is hidden as gone-upstream, never removed;
//   - isLatest is the serving upstream's own when one upstream serves every
//     visible version of the name, otherwise recomputed over them with the
//     deployed rule (deleted versions skipped unless all are);
//   - a version with a local record keeps it (claimed namespaces beat every
//     upstream): the winning copy is compared with it (7.2, compareWithLocal),
//     which may mark it local+upstream, overlay upstream's status or record a
//     conflict;
//   - in a claimed namespace (a claim recorded at startup, or any local record)
//     isLatest is 7.4's over local and mirrored versions together (recomputeLatest).
// changed_at moves only when what is served (server, official, hidden mark,
// origin) changes.
const {latestOf, recomputeLatest} = require('../publish/latest');
const {claimOf, storedClaims} = require('../publish/namespaces');
const {compareWithLocal, touchEnables} = require('../publish/conflicts');

const ORDER_KEY = 'upstream_order';
const REBUILD_BATCH = 500;

async function rebuildName(tx, name, nowIso, {claims, onConflict}) {
  const rows = await tx.all('SELECT version, source, origin, server, official, upstream, mirrored_at, upstream_updated_at, hidden_reason FROM records WHERE name = ?', [name]);
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const claimed = rows.some((r) => r.source === 'local') || Boolean(claimOf(name, claims));
  const copies = await tx.all(`SELECT s.version, s.upstream, s.server, s.official, s.mirrored_at, s.upstream_updated_at, s.hidden_reason
    FROM record_sources s JOIN mirror_upstreams u ON u.name = s.upstream WHERE s.name = ? ORDER BY s.version, u.position`, [name]);
  const winners = new Map();
  for (const c of copies) {
    if (!c.hidden_reason && !winners.has(c.version)) winners.set(c.version, c);
  }
  const versions = new Set([...copies.map((c) => c.version), ...rows.map((r) => r.version)]);
  const targets = [];
  for (const version of versions) {
    const row = byVersion.get(version);
    const w = winners.get(version);
    if (row && row.source === 'local') {
      if (w) {
        await compareWithLocal(tx, {name, version, server: w.server, official: w.official, mirrored_at: w.mirrored_at}, {nowIso, onConflict});
      } else if (row.origin === 'local+upstream') {
        // No upstream has it any more: no longer confirmed by upstream.
        await tx.run("UPDATE records SET origin = 'local', mirrored_at = NULL, changed_at = ? WHERE name = ? AND version = ? AND source = 'local'", [nowIso, name, version]);
        await touchEnables(tx, name, version);
      }
      continue;
    }
    if (w) {
      targets.push({version, row, server: w.server, official: w.official, upstream: w.upstream, mirrored_at: w.mirrored_at,
        upstream_updated_at: w.upstream_updated_at, hidden_reason: null});
    } else if (row) {
      targets.push({version, row, server: row.server, official: row.official, upstream: null, mirrored_at: row.mirrored_at,
        upstream_updated_at: row.upstream_updated_at, hidden_reason: 'gone-upstream'});
    }
  }
  for (const t of targets) t.meta = JSON.parse(t.official);
  const servingUpstreams = new Set(targets.filter((t) => !t.hidden_reason).map((t) => t.upstream));
  const setLatest = (t, value) => {
    if (t.meta.isLatest !== value) { t.meta.isLatest = value; t.official = JSON.stringify(t.meta); }
  };
  if (!claimed && servingUpstreams.size > 1) {
    const latest = latestOf(targets);
    for (const t of targets) setLatest(t, t === latest);
  } else if (!claimed && servingUpstreams.size === 1) {
    // A version no upstream serves any more is not latest while another one is.
    for (const t of targets) if (t.hidden_reason) setLatest(t, false);
  } else if (claimed) {
    // 7.4 decides below; until then a record keeps the isLatest it has, so an
    // unchanged copy is not a change.
    for (const t of targets) setLatest(t, t.row ? JSON.parse(t.row.official).isLatest : false);
  }
  for (const t of targets) {
    const r = t.row;
    if (!r) {
      await tx.run(`INSERT INTO records (source, name, version, server, official, origin, changed_at, mirrored_at, upstream_updated_at, upstream, hidden_reason)
                    VALUES ('mirror', ?, ?, ?, ?, 'mirror', ?, ?, ?, ?, ?)`,
      [name, t.version, t.server, t.official, nowIso, t.mirrored_at, t.upstream_updated_at, t.upstream, t.hidden_reason]);
      continue;
    }
    const servedChange = r.server !== t.server || r.official !== t.official || (r.hidden_reason || null) !== t.hidden_reason;
    const otherChange = r.upstream !== t.upstream || r.mirrored_at !== t.mirrored_at || r.upstream_updated_at !== t.upstream_updated_at;
    if (!servedChange && !otherChange) continue;
    await tx.run(`UPDATE records SET server = ?, official = ?, upstream = ?, mirrored_at = ?, upstream_updated_at = ?, hidden_reason = ?,
                  changed_at = CASE WHEN ? THEN ? ELSE changed_at END WHERE name = ? AND version = ?`,
    [t.server, t.official, t.upstream, t.mirrored_at, t.upstream_updated_at, t.hidden_reason, servedChange ? 1 : 0, nowIso, name, t.version]);
    // A change to what an instance is shown (the remotes, the status, the hidden
    // mark) moves its entries' sequence (9.4).
    if (r.server !== t.server || (r.hidden_reason || null) !== t.hidden_reason || JSON.parse(r.official).status !== t.meta.status) {
      await touchEnables(tx, name, t.version);
    }
  }
  if (claimed) await recomputeLatest(tx, name, nowIso);
}

// Rebuilds the served mirrored records of each name, inside the caller's
// transaction. onConflict({name, version, localSha, upstreamSha}) hears of each
// conflict recorded for the first time (7.2).
async function rebuildNames(tx, names, nowIso, {onConflict} = {}) {
  const claims = await storedClaims(tx);
  for (const name of new Set(names)) await rebuildName(tx, name, nowIso, {claims, onConflict});
}

// Brings mirror_upstreams in line with the configured list, at startup: adds new
// upstreams, sets positions, drops removed ones with their copies. An upstream
// whose url changed (a trailing slash aside) is a different registry under the
// same label: its copies and state are dropped and it starts with a first sync.
// When the order of names differs from the last one applied, or copies were
// dropped, every mirrored name (and every local one an upstream confirmed) is
// rebuilt, in batches; the order is recorded only
// once that is done, so an interrupted rebuild runs again at the next start.
const sameUrl = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

async function applyUpstreams(store, upstreams, nowIso, {onConflict} = {}) {
  const order = JSON.stringify(upstreams.map((u) => u.name));
  const previous = await store.write(async (tx) => {
    const rows = await tx.all('SELECT name, url FROM mirror_upstreams');
    const wanted = new Map(upstreams.map((u, i) => [u.name, {...u, position: i}]));
    let dropped = false;
    const dropCopies = async (name) => {
      await tx.run('DELETE FROM record_sources WHERE upstream = ?', [name]);
      await tx.run('DELETE FROM reconcile_stage WHERE upstream = ?', [name]);
      dropped = true;
    };
    for (const r of rows) {
      if (wanted.has(r.name)) continue;
      await dropCopies(r.name);
      await tx.run('DELETE FROM mirror_upstreams WHERE name = ?', [r.name]);
    }
    const known = new Map(rows.map((r) => [r.name, r]));
    for (const u of wanted.values()) {
      const r = known.get(u.name);
      if (!r) {
        await tx.run('INSERT INTO mirror_upstreams (name, position, url) VALUES (?, ?, ?)', [u.name, u.position, u.url]);
      } else if (r.url !== null && !sameUrl(r.url, u.url)) {
        await dropCopies(u.name);
        await tx.run(`UPDATE mirror_upstreams SET position = ?, url = ?, cursor = NULL, checkpoint = NULL, run_started_at = NULL,
          run_mode = NULL, pages_done = 0, first_sync_done = 0, state = 'idle', last_success_at = NULL, success_started = NULL,
          last_error = NULL, upstream_version = NULL, last_pass_count = NULL, last_reconcile_at = NULL, reconcile_retry_at = NULL,
          reconcile_guard = NULL WHERE name = ?`, [u.position, u.url, u.name]);
      } else {
        await tx.run('UPDATE mirror_upstreams SET position = ?, url = ? WHERE name = ?', [u.position, u.url, u.name]);
      }
    }
    // Dropped copies force a rebuild, at this start or, if it is interrupted, the next.
    if (dropped) await tx.run('DELETE FROM meta_kv WHERE k = ?', [ORDER_KEY]);
    const kv = await tx.get('SELECT v FROM meta_kv WHERE k = ?', [ORDER_KEY]);
    return kv ? kv.v : null;
  });
  if (previous === order) return {rebuilt: false};
  let after = '';
  for (;;) {
    const batch = (await store.read(`SELECT name FROM (SELECT name FROM record_sources UNION SELECT name FROM records WHERE source = 'mirror' OR origin = 'local+upstream')
      WHERE name > ? ORDER BY name LIMIT ?`, [after, REBUILD_BATCH])).map((r) => r.name);
    if (!batch.length) break;
    await store.write((tx) => rebuildNames(tx, batch, nowIso, {onConflict}));
    after = batch[batch.length - 1];
  }
  await store.write((tx) => tx.run('INSERT INTO meta_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [ORDER_KEY, order]));
  return {rebuilt: true};
}

module.exports = {rebuildNames, applyUpstreams};
