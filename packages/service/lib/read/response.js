'use strict';
// The record as served (spec section 5): {server, _meta} where _meta carries the
// official key (upstream's fields only) and our key.
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const OURS = 'io.github.mchen6/countinghouse-registry';

// The columns a served record is built from, with its countinghouse record's
// hash and version if one is stored (8.4), for `record` under our key.
const ROW_COLUMNS = `id, source, name, version, server, official, origin, changed_at, mirrored_at, hidden_reason, upstream,
  (SELECT c.sha256 FROM ch_records c WHERE c.name = records.name AND c.version = records.version) AS ch_sha256,
  (SELECT c.record_version FROM ch_records c WHERE c.name = records.name AND c.version = records.version) AS ch_record_version`;

function toServerResponse(row, view = {}) {
  const ours = {origin: row.origin, changedAt: row.changed_at};
  if (row.mirrored_at) ours.mirroredAt = row.mirrored_at;
  if (view.record) ours.record = view.record;
  else if (row.ch_sha256) ours.record = {sha256: row.ch_sha256, recordVersion: row.ch_record_version};
  if (view.hosting && view.publicHosting !== 'none') ours.hosting = view.hosting;
  // Operator reads only (6.8, 7.2): the attribution and the conflict flag.
  if (view.operator) {
    if (view.upstream) ours.upstream = view.upstream;
    if (view.alsoAt) {
      ours.alsoAt = view.alsoAt;
      ours.differsAt = view.differsAt;
    }
    if (view.conflict) ours.conflict = true;
  }
  let official = JSON.parse(row.official);
  // A record hidden here (gone upstream) is served as deleted wherever deleted
  // records are asked for, so a downstream sync learns it is gone.
  if (row.hidden_reason) official = {...official, status: 'deleted', statusChangedAt: row.changed_at};
  return {server: JSON.parse(row.server), _meta: {[OFFICIAL]: official, [OURS]: ours}};
}

module.exports = {toServerResponse, ROW_COLUMNS, OFFICIAL, OURS};
