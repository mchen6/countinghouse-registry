'use strict';
// An upstream copy of a name@version that exists locally (spec section 7.2). The
// `server` objects are compared as canonical JSON with _meta reduced to
// publisher-provided on both sides:
//   - identical: the local record becomes origin local+upstream with mirroredAt,
//     and an upstream status change made after our last one overlays its status,
//     message and statusChangedAt (7.3); our publishedAt and updatedAt stay; a
//     conflict recorded earlier is closed;
//   - different: the local record stays as served (origin local, no mirroredAt),
//     and a conflict (name, version, both hashes, first seen) is recorded once
//     per differing pair; a new pair reopens an acknowledged one; onConflict
//     hears of each new pair.
const {sha256Canonical} = require('countinghouse-registry-cli/lib/canonical-json');
const {reduceMeta} = require('countinghouse-registry-cli/lib/validate');

// An empty _meta and no _meta are the same document.
function serverHash(json) {
  const doc = reduceMeta(JSON.parse(json));
  if (doc._meta && Object.keys(doc._meta).length === 0) delete doc._meta;
  return sha256Canonical(doc);
}

// A conflict, logged once when first recorded: the hashes' first 12 hex, never
// the records.
const conflictLogger = (log) => ({name, version, localSha, upstreamSha}) =>
  log.warn('publish.conflict', 'an upstream copy differs from the local record', {name, version, local: localSha.slice(0, 12), upstream: upstreamSha.slice(0, 12)});

// A change instances must see (a conflict closed or acknowledged, an override
// set or removed): the name@version's enables take a change sequence value, so
// their next poll returns them (9.4).
// One value lands on at most one row per instance (the key is instance, name,
// version), which keeps a poll page that ends at a value from splitting it;
// touching several versions at once must take one value per version. No value
// is taken when nobody has the entry enabled (a gap in the counter is harmless).
async function touchEnables(tx, name, version) {
  if (!(await tx.get('SELECT 1 AS x FROM enables WHERE name = ? AND version = ? LIMIT 1', [name, version]))) return;
  const seq = await tx.nextSeq();
  await tx.run('UPDATE enables SET seq = ? WHERE name = ? AND version = ?', [seq, name, version]);
}

// A recorded 7.2 conflict not yet acknowledged: it blocks new enables (9.3).
async function openConflict(tx, name, version) {
  return Boolean(await tx.get('SELECT 1 AS x FROM conflicts WHERE name = ? AND version = ? AND ack_at IS NULL', [name, version]));
}

// The keepDeleted override (7.3): permits enables of a deleted or gone version.
async function hasOverride(tx, name, version) {
  return Boolean(await tx.get('SELECT 1 AS x FROM overrides WHERE name = ? AND version = ? AND keep_deleted = 1', [name, version]));
}

// copy: {name, version, server, official (JSON strings), mirrored_at}.
// -> 'none' | 'identical' | 'conflict'.
async function compareWithLocal(tx, copy, {nowIso, onConflict = () => {}} = {}) {
  const local = await tx.get("SELECT server, official, origin, mirrored_at FROM records WHERE name = ? AND version = ? AND source = 'local'", [copy.name, copy.version]);
  if (!local) return 'none';
  const localSha = serverHash(local.server);
  const upstreamSha = serverHash(copy.server);
  if (localSha !== upstreamSha) {
    // Recorded once per differing pair. An acknowledgement covers the pair it was
    // made against, so a new variant (of either side) reopens the conflict:
    // both hashes replaced, the acknowledgement cleared, first_seen kept.
    const prev = await tx.get('SELECT local_sha, upstream_sha FROM conflicts WHERE name = ? AND version = ?', [copy.name, copy.version]);
    if (!prev || prev.local_sha !== localSha || prev.upstream_sha !== upstreamSha) {
      await tx.run(`INSERT INTO conflicts (name, version, local_sha, upstream_sha, first_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (name, version) DO UPDATE SET local_sha = excluded.local_sha, upstream_sha = excluded.upstream_sha, ack_by = NULL, ack_at = NULL`,
      [copy.name, copy.version, localSha, upstreamSha, nowIso]);
      await touchEnables(tx, copy.name, copy.version);
      onConflict({name: copy.name, version: copy.version, localSha, upstreamSha});
    }
    // No longer confirmed by upstream.
    if (local.origin === 'local+upstream' || local.mirrored_at !== null) {
      await tx.run("UPDATE records SET origin = 'local', mirrored_at = NULL, changed_at = ? WHERE name = ? AND version = ? AND source = 'local'", [nowIso, copy.name, copy.version]);
    }
    return 'conflict';
  }
  // An identical copy closes a conflict recorded earlier (the audit keeps any
  // acknowledgement of it); instances serving it learn on their next poll.
  if (await tx.get('DELETE FROM conflicts WHERE name = ? AND version = ? RETURNING name', [copy.name, copy.version])) {
    await touchEnables(tx, copy.name, copy.version);
  }
  const meta = JSON.parse(local.official);
  const up = JSON.parse(copy.official);
  // Upstream's status applies when upstream changed it after our last status
  // change, so a later local PATCH is not undone by the next mirror pass.
  if (up.status !== meta.status && Date.parse(up.statusChangedAt) > Date.parse(meta.statusChangedAt)) {
    meta.status = up.status;
    if (up.statusMessage !== undefined) meta.statusMessage = up.statusMessage;
    else delete meta.statusMessage;
    meta.statusChangedAt = up.statusChangedAt;
  }
  const official = JSON.stringify(meta);
  if (meta.status !== JSON.parse(local.official).status) await touchEnables(tx, copy.name, copy.version);
  if (local.origin !== 'local+upstream' || local.official !== official || local.mirrored_at !== copy.mirrored_at) {
    await tx.run(`UPDATE records SET origin = 'local+upstream', official = ?, mirrored_at = ?,
      changed_at = CASE WHEN ? THEN ? ELSE changed_at END WHERE name = ? AND version = ? AND source = 'local'`,
    [official, copy.mirrored_at, local.origin !== 'local+upstream' || local.official !== official ? 1 : 0, nowIso, copy.name, copy.version]);
  }
  return 'identical';
}

module.exports = {compareWithLocal, serverHash, conflictLogger, touchEnables, openConflict, hasOverride};
