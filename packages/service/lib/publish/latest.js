'use strict';
// Which version of a server is "latest": the official registry's deployed rule
// (internal/service/versioning.go CompareVersions at 7e8fa024, verified live in the
// research note): both strict semver -> semver order; neither -> later publishedAt
// wins; one semver -> the semver one wins. latestOf and recomputeLatest apply it
// to a name's records (spec 7.4).
const {isStrictSemver, compareSemver} = require('countinghouse-registry-cli/lib/semver');

function compareVersions(v1, v2, publishedAt1, publishedAt2) {
  const s1 = isStrictSemver(v1);
  const s2 = isStrictSemver(v2);
  if (s1 && s2) return compareSemver(v1, v2);
  if (!s1 && !s2) {
    const t1 = Date.parse(publishedAt1);
    const t2 = Date.parse(publishedAt2);
    return t1 < t2 ? -1 : t1 > t2 ? 1 : 0;
  }
  return s1 ? 1 : -1;
}

// The latest of a set of records {version, hidden_reason, meta: official}: the
// highest by compareVersions among the visible ones, skipping deleted ones unless
// every visible one is deleted. null when none is visible.
function latestOf(targets) {
  const visible = targets.filter((t) => !t.hidden_reason);
  const live = visible.filter((t) => t.meta.status !== 'deleted');
  const pool = live.length ? live : visible;
  let best = null;
  for (const t of pool) {
    if (!best || compareVersions(t.version, best.version, t.meta.publishedAt, best.meta.publishedAt) > 0) best = t;
  }
  return best;
}

// isLatest of every record of a name, local and mirrored, by 7.4 (claimed
// namespaces), inside the caller's transaction. changed_at moves on the records
// whose isLatest changes.
async function recomputeLatest(tx, name, nowIso) {
  const rows = await tx.all('SELECT version, official, hidden_reason FROM records WHERE name = ?', [name]);
  const targets = rows.map((r) => ({version: r.version, hidden_reason: r.hidden_reason, official: r.official, meta: JSON.parse(r.official)}));
  const best = latestOf(targets);
  for (const t of targets) {
    const want = t === best;
    if (t.meta.isLatest === want) continue;
    t.meta.isLatest = want;
    await tx.run('UPDATE records SET official = ?, changed_at = ? WHERE name = ? AND version = ?', [JSON.stringify(t.meta), nowIso, name, t.version]);
  }
}

module.exports = {compareVersions, latestOf, recomputeLatest};
