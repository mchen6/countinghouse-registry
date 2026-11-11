'use strict';
// The shared canonical serialisation and hash (spec section 8.2). canonicalJSON is a
// copy of countinghouse's lib/mcp/output-schema-hash.js at
// 79ff02deafb7df5765f70bc7f8a5719719258286 (object keys sorted at every depth,
// undefined members dropped, array order kept); a change on one side changes both.
// sha256Canonical is that file's outputSchemaHash for any value. depthWithin is
// ours: canonicalJSON recurses, so callers check the depth of untrusted input first.
const crypto = require('crypto');

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof(value) === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonicalJSON(value)).digest('hex');
}

// Whether no array or object is nested more than `limit` levels deep (a scalar is
// depth 0, `[]` and `{}` depth 1). Iterative, so any input is safe to measure.
function depthWithin(value, limit) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (d + 1 > limit) return false;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return true;
}

module.exports = {canonicalJSON, sha256Canonical, depthWithin};
