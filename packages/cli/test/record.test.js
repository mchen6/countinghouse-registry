'use strict';
// The countinghouse record (spec section 8): its JSON Schema, hash and pointer.
const assert = require('assert');
const {validateRecord, recordHash, pointerOf, MAX_DEPTH} = require('../lib/record');
const {sha256Canonical} = require('../lib/canonical-json');

const PP = 'io.modelcontextprotocol.registry/publisher-provided';
const KEY = 'io.github.mchen6.countinghouse';

function record(extra = {}) {
  return {
    recordVersion: 1, countinghouse: '^8',
    tools: [{name: 'echo', inputSchema: {type: 'object'}}],
    calls: ['log-read/readService.list'], permissions: {fs: {read: ['/tmp']}}, ...extra
  };
}

describe('countinghouse record', () => {
  it('accepts the v1 record', () => {
    assert.deepStrictEqual(validateRecord(record()), {valid: true, errors: []});
    assert.strictEqual(validateRecord(record({tools: [], calls: [], permissions: {}})).valid, true);
  });

  it('rejects extra top-level fields', () => {
    const r = validateRecord(record({price: 1}));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('price')), JSON.stringify(r.errors));
  });

  it('rejects a missing field and a recordVersion other than 1', () => {
    const {calls, ...noCalls} = record();
    assert.ok(calls);
    assert.strictEqual(validateRecord(noCalls).valid, false);
    assert.strictEqual(validateRecord(record({recordVersion: 2})).valid, false);
    assert.strictEqual(validateRecord(null).valid, false);
    assert.strictEqual(validateRecord([]).valid, false);
  });

  it('tool items need name and inputSchema, otherwise open', () => {
    assert.strictEqual(validateRecord(record({tools: [{name: 'x'}]})).valid, false);
    assert.strictEqual(validateRecord(record({tools: [{inputSchema: {}}]})).valid, false);
    assert.strictEqual(validateRecord(record({tools: [{name: 'x', inputSchema: 'no'}]})).valid, false);
    const open = record({tools: [{name: 'x', inputSchema: {}, outputSchema: {type: 'object'}, annotations: {readOnlyHint: true}, title: 'X'}]});
    assert.strictEqual(validateRecord(open).valid, true);
  });

  it(`refuses nesting deeper than ${64} levels without recursing`, () => {
    assert.strictEqual(MAX_DEPTH, 64);
    let deep = {};
    for (let i = 0; i < 200000; i++) deep = {a: deep};
    const r = validateRecord(record({permissions: deep}));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('64')), JSON.stringify(r.errors));
  });

  it('recordHash equals sha256Canonical of the parsed record', () => {
    const r = record();
    assert.match(recordHash(r), /^[0-9a-f]{64}$/);
    assert.strictEqual(recordHash(r), sha256Canonical(JSON.parse(JSON.stringify(r))));
    const reordered = {permissions: r.permissions, calls: r.calls, tools: r.tools, countinghouse: r.countinghouse, recordVersion: 1};
    assert.strictEqual(recordHash(reordered), recordHash(r));
  });

  it('pointerOf reads our pointer from publisher-provided: null only when absent', () => {
    const pointer = {record: 'https://r.example/v0.1/x/io.github.mchen6/countinghouse-registry/records/a%2Fb/versions/1.0.0', sha256: 'a'.repeat(64), recordVersion: 1};
    assert.deepStrictEqual(pointerOf({_meta: {[PP]: {[KEY]: pointer}}}), pointer);
    assert.strictEqual(pointerOf({}), null);
    assert.strictEqual(pointerOf({_meta: {}}), null);
    assert.strictEqual(pointerOf({_meta: {[PP]: {other: 1}}}), null);
    // A malformed pointer is still a pointer: publish refuses it (its sha256 matches no record).
    assert.deepStrictEqual(pointerOf({_meta: {[PP]: {[KEY]: {...pointer, sha256: 'xyz', extra: 1}}}}), {...pointer, sha256: 'xyz'});
    assert.deepStrictEqual(pointerOf({_meta: {[PP]: {[KEY]: 'not an object'}}}), {record: undefined, sha256: undefined, recordVersion: undefined});
  });
});
