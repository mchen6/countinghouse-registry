'use strict';
// Seeds the store with records for read-path tests.
const OFFICIAL = 'io.modelcontextprotocol.registry/official';

function server(name, version, extra = {}) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name, description: `test server ${name}`, version, ...extra
  };
}

function official(extra = {}) {
  const t = extra.publishedAt || '2026-11-01T00:00:00.000000Z';
  return {status: 'active', statusChangedAt: t, publishedAt: t, updatedAt: t, isLatest: true, ...extra};
}

async function insertRecord(store, row) {
  const r = {
    source: 'mirror', origin: 'mirror', changed_at: '2026-11-10T00:00:00.000Z', mirrored_at: null, hidden_reason: null,
    ...row
  };
  r.server = r.server || server(r.name, r.version);
  r.official = r.official || official();
  if (r.mirrored_at === null && r.source === 'mirror') r.mirrored_at = r.changed_at;
  await store.write((tx) => tx.run(
    `INSERT INTO records (source, name, version, server, official, origin, changed_at, mirrored_at, hidden_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.source, r.name, r.version, JSON.stringify(r.server), JSON.stringify(r.official), r.origin, r.changed_at, r.mirrored_at, r.hidden_reason]));
  return r;
}

module.exports = {insertRecord, server, official, OFFICIAL};
