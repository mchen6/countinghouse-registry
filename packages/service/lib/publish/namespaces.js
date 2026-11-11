'use strict';
// Claimed namespaces (spec sections 7.1 and 13.3). A claim is a prefix such as
// "io.github.owner/"; a name is in the first claim it starts with. The claims in
// force are recorded in the store at startup, so the mirror (which has no config)
// applies 7.4 to the names they cover.
const {recomputeLatest} = require('./latest');

const CLAIMS_KEY = 'claims';

const claimOf = (name, claims) => claims.find((c) => typeof name === 'string' && name.startsWith(c)) || null;

async function storedClaims(db) {
  const row = await db.get('SELECT v FROM meta_kv WHERE k = ?', [CLAIMS_KEY]);
  return row ? JSON.parse(row.v) : [];
}

class ClaimError extends Error {
  constructor(names) {
    super(`claimed namespaces removed while they hold local records; publish them under a claim again or restore the claim: ${names.join(', ')}`);
    this.names = names;
  }
}

// At startup: a removed claim that still has local records refuses startup
// (ClaimError listing the names); an added claim recomputes isLatest (7.4) for the
// names it covers; the claims are recorded; a removed claim's names are rebuilt.
async function applyClaims(store, claims, nowIso) {
  return store.write(async (tx) => {
    const locals = (await tx.all("SELECT DISTINCT name FROM records WHERE source = 'local' ORDER BY name")).map((r) => r.name);
    const orphans = locals.filter((n) => !claimOf(n, claims));
    if (orphans.length) throw new ClaimError(orphans);
    const before = await storedClaims(tx);
    const added = claims.filter((c) => !before.includes(c));
    for (const c of added) {
      const names = await tx.all("SELECT DISTINCT name FROM records WHERE substr(name, 1, length(?)) = ? ORDER BY name", [c, c]);
      for (const {name} of names) await recomputeLatest(tx, name, nowIso);
    }
    await tx.run('INSERT INTO meta_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [CLAIMS_KEY, JSON.stringify(claims)]);
    // A removed claim (it holds no local records, checked above) gives its names
    // back to the mirror's rule, rebuilt now that the claim is no longer recorded.
    // Required here: the mirror's projection requires this module.
    const {rebuildNames} = require('../mirror/sources');
    for (const c of before.filter((x) => !claims.includes(x))) {
      const names = await tx.all('SELECT DISTINCT name FROM records WHERE substr(name, 1, length(?)) = ? ORDER BY name', [c, c]);
      await rebuildNames(tx, names.map((n) => n.name), nowIso);
    }
    return {added};
  });
}

module.exports = {claimOf, storedClaims, applyClaims, ClaimError};
