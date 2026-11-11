'use strict';
// The record as served (spec section 5): {server, _meta} where _meta carries the
// official key (upstream's fields only) and our key.
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const OURS = 'io.github.mchen6/countinghouse-registry';

// The columns a served record is built from, with its countinghouse record's
// hash and version if one is stored (8.4), for `record` under our key, and the
// number of instances serving it (validated, 5.2) for `hosting`: subqueries of
// the same statement, so a list page is one query (the count is indexed by
// enables_entry; it is read, and not served, with publicHosting "none").
const ROW_COLUMNS = `id, source, name, version, server, official, origin, changed_at, mirrored_at, hidden_reason, upstream,
  (SELECT c.sha256 FROM ch_records c WHERE c.name = records.name AND c.version = records.version) AS ch_sha256,
  (SELECT c.record_version FROM ch_records c WHERE c.name = records.name AND c.version = records.version) AS ch_record_version,
  (SELECT COUNT(*) FROM enables e WHERE e.name = records.name AND e.version = records.version AND e.state = 'validated') AS hosted_instances`;

function toServerResponse(row, view = {}) {
  const ours = {origin: row.origin, changedAt: row.changed_at};
  if (row.mirrored_at) ours.mirroredAt = row.mirrored_at;
  if (view.record) ours.record = view.record;
  else if (row.ch_sha256) ours.record = {sha256: row.ch_sha256, recordVersion: row.ch_record_version};
  // Public: the aggregate, only while an instance serves it (absent: none does,
  // or the operator hides hosting). Operator reads: always, with per-instance
  // detail (9.6).
  if (view.operator && view.hosting) ours.hosting = view.hosting;
  else if (view.publicHosting !== 'none' && row.hosted_instances > 0) ours.hosting = {hosted: true, instances: row.hosted_instances};
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
