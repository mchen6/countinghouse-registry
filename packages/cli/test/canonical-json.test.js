'use strict';
// The shared hash (spec section 8.2): countinghouse's canonical JSON + sha256, checked
// against countinghouse's own test vectors until N1 adds the module fixture.
const assert = require('assert');
const vectors = require('./fixtures/hash-vectors.json');
const {canonicalJSON, sha256Canonical, depthWithin} = require('../lib/canonical-json');

describe('canonical JSON', () => {
  it("matches countinghouse's hash vectors", () => {
    for (const [a, b] of vectors.same) {
      assert.strictEqual(canonicalJSON(a), canonicalJSON(b));
      assert.strictEqual(sha256Canonical(a), sha256Canonical(b));
    }
    for (const [a, b] of vectors.different) assert.notStrictEqual(sha256Canonical(a), sha256Canonical(b));
    for (const v of vectors.canonical) {
      assert.strictEqual(canonicalJSON(v.value), v.json);
      assert.strictEqual(sha256Canonical(v.value), v.sha256);
    }
  });

  it('sorts keys at every depth and keeps array order', () => {
    assert.strictEqual(canonicalJSON({b: [3, {d: 1, c: 2}], a: null}), '{"a":null,"b":[3,{"c":2,"d":1}]}');
  });

  it('drops undefined members', () => {
    assert.strictEqual(canonicalJSON({a: undefined, b: 1}), '{"b":1}');
  });

  it('depthWithin counts nesting without recursing', () => {
    let deep = 1;
    for (let i = 0; i < 200000; i++) deep = [deep];
    assert.strictEqual(depthWithin(deep, 64), false);
    assert.strictEqual(depthWithin({a: [{b: 1}]}, 3), true);
    assert.strictEqual(depthWithin({a: [{b: {}}]}, 3), false);
    assert.strictEqual(depthWithin('scalar', 0), true);
  });
});
