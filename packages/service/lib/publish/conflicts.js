'use strict';
// An upstream copy of a name@version that exists locally (spec section 7.2). The
// `server` objects are compared as canonical JSON with _meta reduced to
// publisher-provided on both sides:
//   - identical: the local record becomes origin local+upstream with mirroredAt,
//     and an upstream status change made after our last one overlays its status,
//     message and statusChangedAt (7.3); our publishedAt and updatedAt stay;
//   - different: the local record stays as served (origin local, no mirroredAt),
//     and a conflict (name, version, both hashes, first seen) is recorded once;
//     onConflict hears of a new one.
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

// copy: {name, version, server, official (JSON strings), mirrored_at}.
// -> 'none' | 'identical' | 'conflict'.
async function compareWithLocal(tx, copy, {nowIso, onConflict = () => {}} = {}) {
  const local = await tx.get("SELECT server, official, origin, mirrored_at FROM records WHERE name = ? AND version = ? AND source = 'local'", [copy.name, copy.version]);
  if (!local) return 'none';
  const localSha = serverHash(local.server);
  const upstreamSha = serverHash(copy.server);
  if (localSha !== upstreamSha) {
    const inserted = await tx.get(`INSERT INTO conflicts (name, version, local_sha, upstream_sha, first_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (name, version) DO NOTHING RETURNING name`, [copy.name, copy.version, localSha, upstreamSha, nowIso]);
    if (inserted) onConflict({name: copy.name, version: copy.version, localSha, upstreamSha});
    // No longer confirmed by upstream.
    if (local.origin === 'local+upstream' || local.mirrored_at !== null) {
      await tx.run("UPDATE records SET origin = 'local', mirrored_at = NULL, changed_at = ? WHERE name = ? AND version = ? AND source = 'local'", [nowIso, copy.name, copy.version]);
    }
    return 'conflict';
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
  if (local.origin !== 'local+upstream' || local.official !== official || local.mirrored_at !== copy.mirrored_at) {
    await tx.run(`UPDATE records SET origin = 'local+upstream', official = ?, mirrored_at = ?,
      changed_at = CASE WHEN ? THEN ? ELSE changed_at END WHERE name = ? AND version = ? AND source = 'local'`,
    [official, copy.mirrored_at, local.origin !== 'local+upstream' || local.official !== official ? 1 : 0, nowIso, copy.name, copy.version]);
  }
  return 'identical';
}

module.exports = {compareWithLocal, serverHash, conflictLogger};
