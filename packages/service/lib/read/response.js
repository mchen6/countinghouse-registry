'use strict';
// The record as served (spec section 5): {server, _meta} where _meta carries the
// official key (upstream's fields only) and our key.
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const OURS = 'io.github.mchen6/countinghouse-registry';

function toServerResponse(row, view = {}) {
  const ours = {origin: row.origin, changedAt: row.changed_at};
  if (row.mirrored_at) ours.mirroredAt = row.mirrored_at;
  if (view.record) ours.record = view.record;
  if (view.hosting && view.publicHosting !== 'none') ours.hosting = view.hosting;
  if (view.operator && view.conflict) ours.conflict = true;
  let official = JSON.parse(row.official);
  // A record hidden here (gone upstream) is served as deleted wherever deleted
  // records are asked for, so a downstream sync learns it is gone.
  if (row.hidden_reason) official = {...official, status: 'deleted', statusChangedAt: row.changed_at};
  return {server: JSON.parse(row.server), _meta: {[OFFICIAL]: official, [OURS]: ours}};
}

module.exports = {toServerResponse, OFFICIAL, OURS};
