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
  return {server: JSON.parse(row.server), _meta: {[OFFICIAL]: JSON.parse(row.official), [OURS]: ours}};
}

module.exports = {toServerResponse, OFFICIAL, OURS};
