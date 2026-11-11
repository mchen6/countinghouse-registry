'use strict';
// Cases copied from the official registry's internal/service/versioning_test.go
// (github.com/modelcontextprotocol/registry at 7e8fa024): TestCompareSemanticVersions
// and TestCompareVersions.
const assert = require('assert');
const {compareVersions} = require('../lib/publish/latest');

const SEMVER = [
  ['major less', '1.0.0', '2.0.0', -1], ['major greater', '2.0.0', '1.0.0', 1], ['major equal', '1.0.0', '1.0.0', 0],
  ['minor less', '1.1.0', '1.2.0', -1], ['minor greater', '1.2.0', '1.1.0', 1], ['minor equal', '1.2.0', '1.2.0', 0],
  ['patch less', '1.0.1', '1.0.2', -1], ['patch greater', '1.0.2', '1.0.1', 1], ['patch equal', '1.0.1', '1.0.1', 0],
  ['complex less', '1.9.9', '2.0.0', -1], ['complex greater', '2.0.0', '1.9.9', 1], ['complex mixed', '1.10.0', '1.2.0', 1],
  ['prerelease vs stable less', '1.0.0-alpha', '1.0.0', -1], ['stable vs prerelease greater', '1.0.0', '1.0.0-alpha', 1],
  ['prerelease alpha vs beta', '1.0.0-alpha', '1.0.0-beta', -1], ['prerelease beta vs alpha', '1.0.0-beta', '1.0.0-alpha', 1],
  ['prerelease same', '1.0.0-alpha', '1.0.0-alpha', 0], ['prerelease numeric', '1.0.0-1', '1.0.0-2', -1],
  ['prerelease complex', '1.0.0-alpha.1', '1.0.0-alpha.2', -1], ['prerelease rc vs alpha', '1.0.0-rc', '1.0.0-alpha', 1],
  ['prerelease alpha.10 vs alpha.2', '1.0.0-alpha.10', '1.0.0-alpha.2', 1],
  ['prerelease alpha.2 vs alpha.10', '1.0.0-alpha.2', '1.0.0-alpha.10', -1],
  ['prerelease beta.100 vs beta.9', '1.0.0-beta.100', '1.0.0-beta.9', 1],
  ['numeric vs alphanumeric precedence', '1.0.0-1', '1.0.0-alpha', -1],
  ['alphanumeric vs numeric precedence', '1.0.0-alpha', '1.0.0-1', 1],
  ['shorter prerelease list precedence', '1.0.0-alpha', '1.0.0-alpha.1', -1],
  ['longer prerelease list precedence', '1.0.0-alpha.1', '1.0.0-alpha', 1],
  ['mixed numeric and alpha', '1.0.0-alpha.1.beta', '1.0.0-alpha.1.2', 1],
  ['complex prerelease ordering', '1.0.0-rc.1', '1.0.0-rc.10', -1],
  ['zero versions', '0.0.0', '0.0.1', -1], ['large numbers', '100.200.300', '100.200.301', -1]
];

const NOW = '2026-11-10T12:00:00Z';
const EARLIER = '2026-11-10T11:00:00Z';
const LATER = '2026-11-10T13:00:00Z';
const MIXED = [
  ['both semver less', '1.0.0', '2.0.0', NOW, NOW, -1], ['both semver greater', '2.0.0', '1.0.0', NOW, NOW, 1],
  ['both semver equal', '1.0.0', '1.0.0', NOW, NOW, 0], ['both semver ignore timestamps', '1.0.0', '2.0.0', LATER, EARLIER, -1],
  ['neither semver earlier', 'snapshot', 'latest', EARLIER, LATER, -1], ['neither semver later', 'snapshot', 'latest', LATER, EARLIER, 1],
  ['neither semver same time', 'snapshot', 'latest', NOW, NOW, 0],
  ['neither semver v-prefix', 'v2021.03.15', 'v2021.03.16', EARLIER, LATER, -1],
  ['semver vs non-semver', '1.0.0', 'snapshot', NOW, NOW, 1], ['non-semver vs semver', 'snapshot', '1.0.0', NOW, NOW, -1],
  ['semver vs snapshot', '2.0.0', 'snapshot', EARLIER, LATER, 1], ['latest vs semver', 'latest', '1.0.0', LATER, EARLIER, -1],
  ['semver prerelease vs non-semver', '1.0.0-alpha', 'custom', NOW, NOW, 1],
  ['empty vs semver', '', '1.0.0', NOW, NOW, -1], ['semver vs empty', '1.0.0', '', NOW, NOW, 1], ['both empty', '', '', NOW, NOW, 0],
  // ours: the live case from the research note (3.3.0.1 published after 3.3.0 does not win)
  ['one semver: the semver one wins', '3.3.0', '3.3.0.1', '2025-11-06T02:28:08Z', '2025-11-06T02:30:03Z', 1]
];

describe('compareVersions', () => {
  for (const [name, a, b, want] of SEMVER) {
    it(`semver: ${name}`, () => assert.strictEqual(compareVersions(a, b, NOW, NOW), want));
  }
  for (const [name, a, b, ta, tb, want] of MIXED) {
    it(`mixed: ${name}`, () => assert.strictEqual(compareVersions(a, b, ta, tb), want));
  }
});
