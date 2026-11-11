'use strict';
const assert = require('assert');
const path = require('path');
const request = require('supertest');
const {startApp} = require('./support/app');
const {insertRecord, official, OFFICIAL} = require('./support/records');

const OURS = 'io.github.mchen6/countinghouse-registry';
const fixture = (name) => require(path.join(__dirname, 'fixtures', 'upstream', `${name}.json`));

describe('read API', () => {
  let t;
  beforeEach(async () => { t = await startApp(); });
  afterEach(async () => { await t.close(); });

  it('serves the list envelope like upstream', async () => {
    const fx = fixture('list-limit-2');
    for (const r of fx.body.servers) {
      await insertRecord(t.store, {name: r.server.name, version: r.server.version, server: r.server, official: r._meta[OFFICIAL]});
    }
    await insertRecord(t.store, {name: 'zz.after/x', version: '1'});
    const res = await request(t.url).get('/v0.1/servers?limit=2').expect(200);
    assert.strictEqual(res.headers['content-type'], 'application/json');
    assert.strictEqual(res.body.servers.length, 2);
    res.body.servers.forEach((r, i) => {
      assert.deepStrictEqual(r.server, fx.body.servers[i].server);
      assert.deepStrictEqual(r._meta[OFFICIAL], fx.body.servers[i]._meta[OFFICIAL]);
      assert.strictEqual(r._meta[OURS].origin, 'mirror');
      assert.ok(r._meta[OURS].changedAt);
    });
    // A page followed by more records carries nextCursor, as upstream's fixture does.
    assert.deepStrictEqual(Object.keys(res.body.metadata).sort(), Object.keys(fx.body.metadata).sort());
    assert.strictEqual(res.body.metadata.count, 2);
  });

  it('orders by name then version bytewise and pages with nextCursor', async () => {
    const all = [['b/x', '1.0.0'], ['B/x', '1.0.0'], ['a/x', '1.10.0'], ['a/x', '1.2.0'], ['é/x', '1']];
    for (const [name, version] of all) await insertRecord(t.store, {name, version});
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const q = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2';
      const res = await request(t.url).get(`/v0.1/servers?${q}`).expect(200);
      pages++;
      res.body.servers.forEach((r) => seen.push(`${r.server.name}@${r.server.version}`));
      cursor = res.body.metadata.nextCursor;
    } while (cursor);
    assert.strictEqual(pages, 3);
    assert.deepStrictEqual(seen, ['B/x@1.0.0', 'a/x@1.10.0', 'a/x@1.2.0', 'b/x@1.0.0', 'é/x@1']);
  });

  it('a full last page has no nextCursor', async () => {
    for (const n of ['a/x', 'b/x']) await insertRecord(t.store, {name: n, version: '1'});
    const res = await request(t.url).get('/v0.1/servers?limit=2').expect(200);
    assert.strictEqual(res.body.servers.length, 2);
    assert.deepStrictEqual(res.body.metadata, {count: 2});
  });

  it('refuses a cursor that is not ours with 400', async () => {
    const res = await request(t.url).get('/v0.1/servers?cursor=%%%').expect(400);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.strictEqual(res.body.detail, 'Invalid cursor');
  });

  it('version=latest returns only isLatest records', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1', official: official({isLatest: false})});
    await insertRecord(t.store, {name: 'a/x', version: '2'});
    const res = await request(t.url).get('/v0.1/servers?version=latest').expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.version), ['2']);
  });

  it('version=<exact> returns that version of every name', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1'});
    await insertRecord(t.store, {name: 'b/x', version: '1'});
    await insertRecord(t.store, {name: 'b/x', version: '2'});
    const res = await request(t.url).get('/v0.1/servers?version=1').expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.name), ['a/x', 'b/x']);
  });

  it('search is a case-insensitive substring of three or more characters', async () => {
    await insertRecord(t.store, {name: 'io.x/FileSystem', version: '1'});
    await insertRecord(t.store, {name: 'io.x/other', version: '1'});
    await insertRecord(t.store, {name: 'io.y/a%b_c', version: '1'});
    const res = await request(t.url).get('/v0.1/servers?search=lesys').expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.name), ['io.x/FileSystem']);
    const wild = await request(t.url).get(`/v0.1/servers?search=${encodeURIComponent('a%b')}`).expect(200);
    assert.deepStrictEqual(wild.body.servers.map((r) => r.server.name), ['io.y/a%b_c']);
    const none = await request(t.url).get(`/v0.1/servers?search=${encodeURIComponent('x_o')}`).expect(200);
    assert.deepStrictEqual(none.body.servers, [], '_ must not be a wildcard');
  });

  it('search=ab returns the upstream 422', async () => {
    const fx = fixture('search-too-short');
    const res = await request(t.url).get('/v0.1/servers?search=ab').expect(422);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.deepStrictEqual(res.body, fx.body);
  });

  it('include_deleted defaults to false; updated_since forces it; include_deleted=false with updated_since is 400', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1', official: official({status: 'deleted'})});
    await insertRecord(t.store, {name: 'b/x', version: '1'});
    let res = await request(t.url).get('/v0.1/servers').expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.name), ['b/x']);
    res = await request(t.url).get('/v0.1/servers?include_deleted=true').expect(200);
    assert.strictEqual(res.body.servers.length, 2);
    res = await request(t.url).get('/v0.1/servers?updated_since=2020-01-01T00:00:00Z').expect(200);
    assert.strictEqual(res.body.servers.length, 2);
    await request(t.url).get('/v0.1/servers?updated_since=2020-01-01T00:00:00Z&include_deleted=false').expect(400);
  });

  it('hidden records are treated as deleted', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1', hidden_reason: 'gone-upstream'});
    let res = await request(t.url).get('/v0.1/servers').expect(200);
    assert.deepStrictEqual(res.body.servers, []);
    await request(t.url).get('/v0.1/servers/a%2Fx/versions/1').expect(404);
    res = await request(t.url).get('/v0.1/servers?include_deleted=true').expect(200);
    assert.strictEqual(res.body.servers.length, 1);
  });

  it('updated_since filters on changedAt, not updatedAt', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1',
      official: official({publishedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z'}), changed_at: '2026-11-10T00:00:00.000Z'});
    await insertRecord(t.store, {name: 'b/x', version: '1',
      official: official({updatedAt: '2026-11-09T00:00:00Z'}), changed_at: '2026-11-01T00:00:00.000Z'});
    const res = await request(t.url).get('/v0.1/servers?updated_since=2026-11-05T00:00:00Z').expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.name), ['a/x']);
  });

  it('detail serves latest and exact versions; 404 is problem+json "Server not found"', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1.0.0', official: official({isLatest: false})});
    await insertRecord(t.store, {name: 'a/x', version: '2.0.0'});
    let res = await request(t.url).get('/v0.1/servers/a%2Fx/versions/latest').expect(200);
    assert.strictEqual(res.body.server.version, '2.0.0');
    res = await request(t.url).get('/v0.1/servers/a%2Fx/versions/1.0.0').expect(200);
    assert.strictEqual(res.body.server.version, '1.0.0');
    const fx = fixture('not-found');
    res = await request(t.url).get('/v0.1/servers/nope%2Fnope/versions/latest').expect(404);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.deepStrictEqual(res.body, fx.body);
    res = await request(t.url).get('/v0.1/servers/nope%2Fnope/versions').expect(404);
    assert.deepStrictEqual(res.body, fixture('not-found-versions').body);
  });

  it('detail of a deleted version needs include_deleted', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1', official: official({status: 'deleted'})});
    await request(t.url).get('/v0.1/servers/a%2Fx/versions/1').expect(404);
    await request(t.url).get('/v0.1/servers/a%2Fx/versions/1?include_deleted=true').expect(200);
    await request(t.url).get('/v0.1/servers/a%2Fx/versions').expect(404);
    await request(t.url).get('/v0.1/servers/a%2Fx/versions?include_deleted=true').expect(200);
  });

  it('decodes %2F and %2B in path segments', async () => {
    await insertRecord(t.store, {name: 'io.github.a/b', version: '1.0.0+build.1'});
    let res = await request(t.url).get('/v0.1/servers/io.github.a%2Fb/versions/1.0.0%2Bbuild.1').expect(200);
    assert.strictEqual(res.body.server.version, '1.0.0+build.1');
    res = await request(t.url).get('/v0.1/servers/io.github.a%2Fb/versions/1.0.0+build.1').expect(200);
    assert.strictEqual(res.body.server.name, 'io.github.a/b');
  });

  it('/versions orders by publishedAt descending', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1', official: official({publishedAt: '2026-01-01T00:00:00Z', isLatest: false})});
    await insertRecord(t.store, {name: 'a/x', version: '3', official: official({publishedAt: '2026-03-01T00:00:00Z'})});
    await insertRecord(t.store, {name: 'a/x', version: '2', official: official({publishedAt: '2026-02-01T00:00:00Z', isLatest: false})});
    const res = await request(t.url).get('/v0.1/servers/a%2Fx/versions').expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.version), ['3', '2', '1']);
    assert.deepStrictEqual(res.body.metadata, {count: 3});
  });

  it('every route answers identically under /v0', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1'});
    for (const p of ['/servers', '/servers/a%2Fx/versions', '/servers/a%2Fx/versions/latest', '/servers?search=ab', '/ping', '/health']) {
      const a = await request(t.url).get(`/v0.1${p}`);
      const b = await request(t.url).get(`/v0${p}`);
      assert.strictEqual(b.status, a.status, p);
      assert.deepStrictEqual(b.body, a.body, p);
    }
  });

  it('read routes send Access-Control-Allow-Origin * and the expose header; OPTIONS preflight answers 204', async () => {
    const res = await request(t.url).get('/v0.1/servers').set('Origin', 'https://example.org').expect(200);
    assert.strictEqual(res.headers['access-control-allow-origin'], '*');
    assert.strictEqual(res.headers['access-control-expose-headers'], 'Content-Type, Content-Length');
    const nf = await request(t.url).get('/v0.1/servers/nope%2Fnope/versions/latest').expect(404);
    assert.strictEqual(nf.headers['access-control-allow-origin'], '*');
    const pre = await request(t.url).options('/v0.1/servers').set('Origin', 'https://example.org')
      .set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'content-type').expect(204);
    assert.strictEqual(pre.headers['access-control-allow-origin'], '*');
    assert.strictEqual(pre.headers['access-control-allow-methods'], 'GET');
    assert.strictEqual(pre.headers['access-control-allow-headers'], 'content-type');
    assert.strictEqual(pre.headers['access-control-max-age'], '86400');
  });

  it('ping, version, /v0.1/health and /healthz', async () => {
    let res = await request(t.url).get('/v0.1/ping').expect(200);
    assert.deepStrictEqual(res.body, fixture('ping').body);
    res = await request(t.url).get('/v0.1/version').expect(200);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['build_time', 'git_commit', 'version']);
    assert.strictEqual(res.body.version, require('../package.json').version);
    res = await request(t.url).get('/v0.1/health').expect(200);
    assert.deepStrictEqual(res.body, {status: 'ok'});
    res = await request(t.url).get('/healthz').expect(200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.store, 'ok');
  });

  it('health answers 503 when the store does not', async () => {
    const real = t.store.read;
    t.store.read = () => Promise.reject(new Error('disk gone'));
    try {
      let res = await request(t.url).get('/healthz').expect(503);
      assert.deepStrictEqual(res.body, {ok: false, store: 'error', mirror: null, upstreams: null});
      res = await request(t.url).get('/v0.1/health').expect(503);
      assert.deepStrictEqual(res.body, {status: 'error'});
    } finally {
      t.store.read = real;
    }
  });

  it('unknown routes are problem+json 404', async () => {
    const res = await request(t.url).get('/v0.1/nonexistent').expect(404);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.deepStrictEqual(res.body, {title: 'Not Found', status: 404, detail: 'Endpoint not found.'});
  });

  it('a store error on a read is a 500 problem without internals', async () => {
    t.store.read = () => Promise.reject(new Error('SQLITE_CORRUPT: secret path /var/x'));
    const res = await request(t.url).get('/v0.1/servers').expect(500);
    assert.deepStrictEqual(res.body, {title: 'Internal Server Error', status: 500, detail: 'Failed to list servers'});
  });

  it('search folds case beyond ASCII', async () => {
    await insertRecord(t.store, {name: 'io.github.x/über-tool', version: '1'});
    const res = await request(t.url).get(`/v0.1/servers?search=${encodeURIComponent('ÜBER')}`).expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.name), ['io.github.x/über-tool']);
  });

  it('search treats double quotes as text', async () => {
    await insertRecord(t.store, {name: 'io.x/abc', version: '1'});
    const res = await request(t.url).get(`/v0.1/servers?search=${encodeURIComponent('a"b')}`).expect(200);
    assert.deepStrictEqual(res.body.servers, []);
  });

  it('serves a hidden record as deleted when deleted records are asked for', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1', hidden_reason: 'gone-upstream', changed_at: '2026-11-10T05:00:00.000Z'});
    for (const p of ['/v0.1/servers?updated_since=2026-11-01T00:00:00Z', '/v0.1/servers?include_deleted=true']) {
      const res = await request(t.url).get(p).expect(200);
      assert.strictEqual(res.body.servers[0]._meta[OFFICIAL].status, 'deleted', p);
    }
    const d = await request(t.url).get('/v0.1/servers/a%2Fx/versions/1?include_deleted=true').expect(200);
    assert.strictEqual(d.body._meta[OFFICIAL].status, 'deleted');
    assert.strictEqual(d.body._meta[OFFICIAL].statusChangedAt, '2026-11-10T05:00:00.000Z');
  });

  it('a bad path encoding is a problem+json 400, not HTML', async () => {
    const res = await request(t.url).get('/v0.1/servers/%E0/versions').expect(400);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.strictEqual(res.body.detail, 'Invalid server name encoding');
  });

  it('a version whose publishedAt is missing sorts last, deterministically', async () => {
    await insertRecord(t.store, {name: 'a/x', version: '1', official: official({publishedAt: '2026-01-01T00:00:00Z', isLatest: false})});
    await insertRecord(t.store, {name: 'a/x', version: '0', official: {status: 'active', isLatest: false}});
    await insertRecord(t.store, {name: 'a/x', version: '2', official: official({publishedAt: '2026-02-01T00:00:00Z'})});
    const res = await request(t.url).get('/v0.1/servers/a%2Fx/versions').expect(200);
    assert.deepStrictEqual(res.body.servers.map((r) => r.server.version), ['2', '1', '0']);
  });

  it('CORS headers and preflights are for GET only', async () => {
    const res = await request(t.url).post('/v0.1/servers').set('Origin', 'https://example.org');
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    const pre = await request(t.url).options('/v0.1/servers').set('Origin', 'https://example.org')
      .set('Access-Control-Request-Method', 'POST');
    assert.notStrictEqual(pre.status, 204);
    assert.strictEqual(pre.headers['access-control-allow-origin'], undefined);
  });
});
