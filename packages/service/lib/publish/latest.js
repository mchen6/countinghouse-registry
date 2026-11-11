'use strict';
// Which version of a server is "latest": the official registry's deployed rule
// (internal/service/versioning.go CompareVersions at 7e8fa024, verified live in the
// research note): both strict semver -> semver order; neither -> later publishedAt
// wins; one semver -> the semver one wins.
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

module.exports = {compareVersions};
