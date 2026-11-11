'use strict';
// Semantic versions as the official registry reads them: Go's golang.org/x/mod/semver
// (the "v" prefix optional, as upstream adds it) plus upstream's own rule of exactly
// three numeric parts (internal/service/versioning.go IsSemanticVersion, at 7e8fa024).
// Numbers have no leading zeros; prerelease identifiers are [0-9A-Za-z-], non-empty,
// numeric ones without leading zeros; build metadata is allowed and ignored.

const NUM = '(0|[1-9][0-9]*)';
const IDENT = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const RE = new RegExp(`^v?${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

function parse(v) {
  const m = typeof v === 'string' ? RE.exec(v) : null;
  if (!m) return null;
  return {major: m[1], minor: m[2], patch: m[3], pre: m[4] === undefined ? null : m[4].split('.')};
}

function isStrictSemver(v) {
  return parse(v) !== null;
}

// Compares two digit strings without leading zeros, of any length.
function compareNum(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdent(a, b) {
  const an = /^[0-9]+$/.test(a);
  const bn = /^[0-9]+$/.test(b);
  if (an && bn) return compareNum(a, b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// -1, 0 or 1; both arguments must be valid (isStrictSemver).
function compareSemver(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (const k of ['major', 'minor', 'patch']) {
    const c = compareNum(x[k], y[k]);
    if (c) return c;
  }
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : (x.pre ? -1 : 1);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const c = compareIdent(x.pre[i], y.pre[i]);
    if (c) return c;
  }
  return x.pre.length === y.pre.length ? 0 : (x.pre.length < y.pre.length ? -1 : 1);
}

module.exports = {isStrictSemver, compareSemver};
