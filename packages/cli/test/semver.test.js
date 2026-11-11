'use strict';
// Cases copied from the official registry's internal/service/versioning_test.go
// (github.com/modelcontextprotocol/registry at 7e8fa024), TestIsSemanticVersion.
const assert = require('assert');
const {isStrictSemver, compareSemver} = require('../lib/semver');

const VALID = [
  ['basic semver', '1.0.0', true], ['with patch', '1.2.3', true], ['with zeros', '0.0.0', true],
  ['large numbers', '100.200.300', true], ['with prerelease alpha', '1.0.0-alpha', true],
  ['with prerelease beta', '2.1.3-beta', true], ['with prerelease rc', '3.0.0-rc', true],
  ['with prerelease number', '1.0.0-1', true], ['with prerelease complex', '1.0.0-alpha.1', true],
  ['with prerelease dots', '1.0.0-beta.2.3', true], ['date format', '2021.11.15', true],
  ['with hyphen in prerelease', '1.0.0-pre-release', true], ['with v prefix', 'v1.0.0', true],
  ['empty string', '', false], ['single number', '1', false], ['two parts only', '1.0', false],
  ['four parts', '1.0.0.0', false], ['non-numeric major', 'a.0.0', false], ['non-numeric minor', '1.b.0', false],
  ['non-numeric patch', '1.0.c', false], ['empty prerelease', '1.0.0-', false],
  ['special chars in prerelease', '1.0.0-alpha@1', false], ['snapshot', 'snapshot', false],
  ['latest', 'latest', false], ['with leading zeros', '2021.03.05', false],
  // ours: Go's x/mod/semver accepts build metadata and rejects numeric prerelease leading zeros
  ['with build metadata', '1.0.0-rc.1+b.7', true], ['numeric prerelease leading zero', '1.0.0-01', false],
  ['the research note case', '3.3.0.1', false]
];

describe('semver', () => {
  for (const [name, v, want] of VALID) {
    it(`isStrictSemver: ${name}`, () => assert.strictEqual(isStrictSemver(v), want, v));
  }

  it('compareSemver ignores build metadata', () => {
    assert.strictEqual(compareSemver('1.0.0+a', '1.0.0+b'), 0);
  });
});
