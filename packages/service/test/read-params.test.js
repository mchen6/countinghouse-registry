'use strict';
const assert = require('assert');
const path = require('path');
const {parseListParams} = require('../lib/read/params');

const fixture = (name) => require(path.join(__dirname, 'fixtures', 'upstream', `${name}.json`));
const queryOf = (fx) => Object.fromEntries(new URL(fx.path, 'http://x').searchParams);

describe('read params', () => {
  for (const name of ['search-too-short', 'limit-101', 'limit-0', 'limit-abc', 'bad-updated-since',
    'include-deleted-false-with-updated-since', 'include-deleted-maybe']) {
    it(`answers ${name} exactly as upstream does`, () => {
      const fx = fixture(name);
      const r = parseListParams(queryOf(fx));
      assert.ok(r.problem, `no problem for ${fx.path}`);
      assert.deepStrictEqual(r.problem, fx.body);
    });
  }

  it('applies the defaults', () => {
    assert.deepStrictEqual(parseListParams({}).params, {
      cursor: null, limit: 30, search: null, updatedSince: null, version: null, includeDeleted: false
    });
  });

  it('updated_since forces include_deleted', () => {
    const r = parseListParams({updated_since: '2026-11-01T00:00:00Z'});
    assert.strictEqual(r.params.includeDeleted, true);
    assert.strictEqual(r.params.updatedSince, '2026-11-01T00:00:00.000Z');
  });

  it('accepts RFC 3339 with fractional seconds and offsets', () => {
    assert.strictEqual(parseListParams({updated_since: '2026-11-01T01:00:00.5+01:00'}).params.updatedSince, '2026-11-01T00:00:00.500Z');
  });

  it('an empty search keeps the normal listing', () => {
    assert.strictEqual(parseListParams({search: ''}).params.search, null);
  });

  it('counts search length in Unicode characters after trimming', () => {
    assert.ok(parseListParams({search: '  ab  '}).problem);
    assert.strictEqual(parseListParams({search: ' 文件系 '}).params.search, ' 文件系 ');
  });

  it('reports several type errors together, like upstream', () => {
    const r = parseListParams({limit: 'abc', include_deleted: 'maybe'});
    assert.strictEqual(r.problem.errors.length, 2);
  });
});
