'use strict';
// Local publishing (spec section 7), the validate endpoint (4.2), countinghouse
// records (8.4) and request bodies (body caps, 9.4).
const assert = require('assert');
const request = require('supertest');
const {startApp} = require('./support/app');
const {fakeAuth, publisher} = require('./support/auth');
const {insertRecord} = require('./support/records');
const {applyClaims} = require('../lib/publish/namespaces');
const {sha256Canonical} = require('countinghouse-registry-cli/lib/canonical-json');

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const OURS = 'io.github.mchen6/countinghouse-registry';
const PP = 'io.modelcontextprotocol.registry/publisher-provided';
const X = '/v0.1/x/io.github.mchen6/countinghouse-registry';
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const CLAIMS = ['io.github.example/'];

function server(name, version, extra = {}) {
  return {$schema: SCHEMA, name, description: 'A test server', version, ...extra};
}

function chRecord(extra = {}) {
  return {recordVersion: 1, countinghouse: '^8', tools: [{name: 'echo', inputSchema: {type: 'object'}}], calls: [], permissions: {}, ...extra};
}

const recordPath = (name, version) => `${X}/records/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
const pointer = (name, version, sha256) => ({[PP]: {'io.github.mchen6.countinghouse': {record: `https://r.example${recordPath(name, version)}`, sha256, recordVersion: 1}}});

describe('local publishing', () => {
  let t;
  const start = async (actor = publisher(CLAIMS)) => {
    t = await startApp({config: {claims: CLAIMS}, deps: {auth: fakeAuth(actor)}});
    await applyClaims(t.store, CLAIMS, new Date().toISOString());
  };
  afterEach(async () => { if (t) await t.close(); t = null; });

  const publish = (doc) => request(t.url).post('/v0.1/publish').set('Content-Type', 'application/json').send(JSON.stringify(doc));

  it('publishes in a claimed namespace and serves the record with origin local and our clock', async () => {
    await start();
    const before = Date.now();
    const res = await publish(server('io.github.example/weather', '1.0.0')).expect(200);
    assert.strictEqual(res.headers['content-type'], 'application/json');
    const o = res.body._meta[OFFICIAL];
    assert.deepStrictEqual(Object.keys(o).sort(), ['isLatest', 'publishedAt', 'status', 'statusChangedAt', 'updatedAt']);
    assert.strictEqual(o.status, 'active');
    assert.strictEqual(o.isLatest, true);
    assert.strictEqual(o.publishedAt, o.updatedAt);
    assert.strictEqual(o.statusChangedAt, o.publishedAt);
    assert.match(o.publishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/);
    assert.ok(Date.parse(o.publishedAt) >= before - 1);
    assert.strictEqual(res.body._meta[OURS].origin, 'local');
    assert.deepStrictEqual(res.body.server, server('io.github.example/weather', '1.0.0'));
    const read = await request(t.url).get('/v0.1/servers/io.github.example%2Fweather/versions/latest').expect(200);
    assert.deepStrictEqual(read.body, res.body);
    // mcp-publisher speaks /v0.
    await request(t.url).post('/v0/publish').set('Content-Type', 'application/json').send(JSON.stringify(server('io.github.example/weather', '1.1.0'))).expect(200);
  });

  it('a second local version takes isLatest by the deployed rule', async () => {
    await start();
    await publish(server('io.github.example/ws', '1.2.0')).expect(200);
    await publish(server('io.github.example/ws', '1.10.0')).expect(200);
    await publish(server('io.github.example/ws', '1.3.0')).expect(200);
    const res = await request(t.url).get('/v0.1/servers/io.github.example%2Fws/versions/latest').expect(200);
    assert.strictEqual(res.body.server.version, '1.10.0');
    const all = await request(t.url).get('/v0.1/servers?search=example%2Fws').expect(200);
    assert.deepStrictEqual(all.body.servers.filter((s) => s._meta[OFFICIAL].isLatest).map((s) => s.server.version), ['1.10.0']);
  });

  it('401 without a token', async () => {
    await start(null);
    await publish(server('io.github.example/weather', '1.0.0')).expect(401);
  });

  it("403 outside the actor's namespaces", async () => {
    t = await startApp({config: {claims: ['io.github.example/', 'io.github.other/']}, deps: {auth: fakeAuth(publisher(['io.github.example/']))}});
    await applyClaims(t.store, ['io.github.example/', 'io.github.other/'], new Date().toISOString());
    const res = await publish(server('io.github.other/weather', '1.0.0')).expect(403);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.ok(res.body.detail.includes('io.github.example/'), res.body.detail);
  });

  it('403 for a name in no claim, even with a key that lists it', async () => {
    await start(publisher(['io.github.example/', 'io.github.unclaimed/']));
    const res = await publish(server('io.github.unclaimed/weather', '1.0.0')).expect(403);
    assert.ok(res.body.detail.includes('claimed'), res.body.detail);
  });

  it('409 on a second publish of the same name@version', async () => {
    await start();
    await publish(server('io.github.example/weather', '1.0.0')).expect(200);
    const res = await publish(server('io.github.example/weather', '1.0.0', {description: 'changed'})).expect(409);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
  });

  it('422 with upstream-shaped issues for an invalid document', async () => {
    await start();
    const res = await publish(server('io.github.example/weather', '^1.0.0')).expect(422);
    assert.strictEqual(res.headers['content-type'], 'application/problem+json');
    assert.strictEqual(res.body.detail, 'Failed to publish server, invalid schema: call /validate for details');
    const issue = res.body.issues.find((i) => i.reference === 'version-looks-like-range');
    assert.deepStrictEqual(Object.keys(issue).sort(), ['message', 'path', 'reference', 'severity', 'type']);
    await request(t.url).get('/v0.1/servers/io.github.example%2Fweather/versions/latest').expect(404);
  });

  it('422 "unexpected property" for a property upstream does not decode, in huma\'s shape', async () => {
    await start();
    const res = await publish(server('io.github.example/weather', '1.0.0', {unknownField: 1})).expect(422);
    assert.strictEqual(res.body.detail, 'validation failed');
    assert.deepStrictEqual(res.body.errors.map((e) => [e.message, e.location]), [['unexpected property', 'body.unknownField']]);
  });

  it('422 for a non-object body, and for nesting deeper than 64', async () => {
    await start();
    for (const body of [[], 'x', 3, null]) {
      await request(t.url).post('/v0.1/publish').set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(422);
    }
    let deep = {};
    for (let i = 0; i < 70; i++) deep = {a: deep};
    await publish(server('io.github.example/weather', '1.0.0', {_meta: {[PP]: deep}})).expect(422);
  });

  it('422 when the pointer sha256 does not match a stored record, naming 12-hex prefixes and not the record', async () => {
    await start();
    const name = 'io.github.example/mod';
    const rec = chRecord({tools: [{name: 'secret-tool-name', inputSchema: {}}]});
    const put = await request(t.url).put(recordPath(name, '1.0.0')).set('Content-Type', 'application/json').send(JSON.stringify(rec)).expect(201);
    const wrong = 'f'.repeat(64);
    const res = await publish(server(name, '1.0.0', {_meta: pointer(name, '1.0.0', wrong)})).expect(422);
    assert.ok(res.body.detail.includes(wrong.slice(0, 12)), res.body.detail);
    assert.ok(res.body.detail.includes(put.body.sha256.slice(0, 12)), res.body.detail);
    assert.ok(!JSON.stringify(res.body).includes('secret-tool-name'));
    assert.ok(!JSON.stringify(res.body).includes(put.body.sha256.slice(12)));
    // No record at all for that version: the pointer's prefix only.
    const none = await publish(server(name, '2.0.0', {_meta: pointer(name, '2.0.0', wrong)})).expect(422);
    assert.ok(none.body.detail.includes(wrong.slice(0, 12)), none.body.detail);
    // A malformed pointer is refused, not ignored.
    await publish(server(name, '2.0.0', {_meta: {[PP]: {'io.github.mchen6.countinghouse': 'nope'}}})).expect(422);
    // The right hash publishes.
    await publish(server(name, '1.0.0', {_meta: pointer(name, '1.0.0', put.body.sha256)})).expect(200);
  });

  it('PUT and DELETE of a version are 501', async () => {
    await start();
    await publish(server('io.github.example/weather', '1.0.0')).expect(200);
    const put = await request(t.url).put('/v0.1/servers/io.github.example%2Fweather/versions/1.0.0').send({}).expect(501);
    assert.strictEqual(put.headers['content-type'], 'application/problem+json');
    await request(t.url).delete('/v0/servers/io.github.example%2Fweather/versions/1.0.0').expect(501);
  });

  it('a read with a JSON content type and a malformed body is still a read', async () => {
    await start();
    const res = await request(t.url).get('/v0.1/servers').set('Content-Type', 'application/json').send('{not json').expect(200);
    assert.deepStrictEqual(res.body.metadata, {count: 0});
  });

  it('write routes send no CORS headers', async () => {
    await start();
    const res = await publish(server('io.github.example/weather', '1.0.0')).set('Origin', 'https://example.org').expect(200);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
  });

  describe('status', () => {
    const patch = (p, body) => request(t.url).patch(p).set('Content-Type', 'application/json').send(JSON.stringify(body));
    const P = '/v0.1/servers/io.github.example%2Fweather';

    it('status PATCH on a local record moves updatedAt and statusChangedAt; on a mirrored record is 409', async () => {
      await start();
      const first = await publish(server('io.github.example/weather', '1.0.0')).expect(200);
      await new Promise((r) => setTimeout(r, 5));
      const res = await patch(`${P}/versions/1.0.0/status`, {status: 'deprecated', statusMessage: 'use 2.x'}).expect(200);
      const o = res.body._meta[OFFICIAL];
      assert.strictEqual(o.status, 'deprecated');
      assert.strictEqual(o.statusMessage, 'use 2.x');
      assert.ok(o.updatedAt > first.body._meta[OFFICIAL].updatedAt);
      assert.strictEqual(o.statusChangedAt, o.updatedAt);
      assert.strictEqual(o.publishedAt, first.body._meta[OFFICIAL].publishedAt);
      assert.ok(res.body._meta[OURS].changedAt > first.body._meta[OURS].changedAt);
      await insertRecord(t.store, {name: 'io.github.example/mirrored', version: '1.0.0'});
      const m = await patch('/v0.1/servers/io.github.example%2Fmirrored/versions/1.0.0/status', {status: 'deprecated'}).expect(409);
      assert.strictEqual(m.body.detail, 'mirrored records follow upstream; use an override');
      await patch('/v0.1/servers/io.github.example%2Fnone/versions/1.0.0/status', {status: 'deprecated'}).expect(404);
    });

    it('statusMessage is refused with status active', async () => {
      await start();
      await publish(server('io.github.example/weather', '1.0.0')).expect(200);
      const res = await patch(`${P}/versions/1.0.0/status`, {status: 'active', statusMessage: 'x'}).expect(400);
      assert.strictEqual(res.body.detail, 'status_message cannot be provided when setting status to active');
    });

    it('a no-op is 400 and a bad status is 422, as upstream', async () => {
      await start();
      await publish(server('io.github.example/weather', '1.0.0')).expect(200);
      const same = await patch(`${P}/versions/1.0.0/status`, {status: 'active'}).expect(400);
      assert.strictEqual(same.body.detail, 'No changes to apply: status and message are already set to the provided values');
      await patch(`${P}/versions/1.0.0/status`, {status: 'gone'}).expect(422);
      await patch(`${P}/versions/1.0.0/status`, {status: 'deprecated', extra: 1}).expect(422);
    });

    it('deleting the latest version moves isLatest to the next one', async () => {
      await start();
      await publish(server('io.github.example/weather', '1.0.0')).expect(200);
      await publish(server('io.github.example/weather', '2.0.0')).expect(200);
      await patch(`${P}/versions/2.0.0/status`, {status: 'deleted'}).expect(200);
      const res = await request(t.url).get(`${P}/versions/latest`).expect(200);
      assert.strictEqual(res.body.server.version, '1.0.0');
    });

    it('the all-versions form updates every local version and answers {updatedCount, servers}', async () => {
      await start();
      await publish(server('io.github.example/weather', '1.0.0')).expect(200);
      await publish(server('io.github.example/weather', '2.0.0')).expect(200);
      const res = await patch(`${P}/status`, {status: 'deprecated', statusMessage: 'moved'}).expect(200);
      assert.strictEqual(res.body.updatedCount, 2);
      assert.deepStrictEqual(res.body.servers.map((s) => s._meta[OFFICIAL].status), ['deprecated', 'deprecated']);
      const again = await patch(`${P}/status`, {status: 'deprecated', statusMessage: 'moved'}).expect(400);
      assert.strictEqual(again.body.detail, 'No changes to apply: all versions already have the requested status and message');
    });
  });

  describe('countinghouse records', () => {
    const put = (name, version, body) => request(t.url).put(recordPath(name, version)).set('Content-Type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));

    it('record PUT: 201 new, 200 identical, 409 different, 422 invalid', async () => {
      await start();
      const n = 'io.github.example/mod';
      const created = await put(n, '1.0.0', chRecord()).expect(201);
      assert.deepStrictEqual(created.body, {sha256: sha256Canonical(chRecord())});
      // The same content with its keys in another order is identical.
      const same = {permissions: {}, calls: [], tools: chRecord().tools, countinghouse: '^8', recordVersion: 1};
      assert.deepStrictEqual((await put(n, '1.0.0', same).expect(200)).body, created.body);
      await put(n, '1.0.0', chRecord({calls: ['a/b.c']})).expect(409);
      const bad = await put(n, '1.1.0', chRecord({price: 1})).expect(422);
      assert.ok(bad.body.errors.some((e) => e.includes('price')), JSON.stringify(bad.body));
      await put('io.github.unclaimed/mod', '1.0.0', chRecord()).expect(403);
    });

    it('413 over 1 MiB', async () => {
      await start();
      const big = chRecord({permissions: {blob: 'x'.repeat(1024 * 1024)}});
      const res = await put('io.github.example/mod', '1.0.0', big).expect(413);
      assert.strictEqual(res.headers['content-type'], 'application/problem+json');
      assert.strictEqual(res.body.detail, 'The request body exceeds 1 MiB');
    });

    it('413 over 500 tools', async () => {
      await start();
      const tools = Array.from({length: 501}, (_, i) => ({name: `t${i}`, inputSchema: {}}));
      const res = await put('io.github.example/mod', '1.0.0', chRecord({tools})).expect(413);
      assert.strictEqual(res.body.detail, 'A record holds at most 500 tools');
      await put('io.github.example/mod', '1.0.0', chRecord({tools: tools.slice(0, 500)})).expect(201);
    });

    it('a body of deeply nested arrays under 1 MiB is a 4xx and the process stays up', async () => {
      await start();
      const body = `${'['.repeat(200000)}${']'.repeat(200000)}`;
      const res = await put('io.github.example/mod', '1.0.0', body);
      assert.ok(res.status >= 400 && res.status < 500, String(res.status));
      const deepObject = `{"recordVersion":1,"countinghouse":"^8","tools":[],"calls":[],"permissions":${'{"a":'.repeat(100000)}1${'}'.repeat(100000)}}`;
      const r2 = await put('io.github.example/mod', '1.0.0', deepObject);
      assert.ok(r2.status >= 400 && r2.status < 500, String(r2.status));
      await request(t.url).get('/v0.1/ping').expect(200);
    });

    it('an unparseable body is a 400 problem naming the JSON', async () => {
      await start();
      const res = await put('io.github.example/mod', '1.0.0', '{"recordVersion":').expect(400);
      assert.strictEqual(res.headers['content-type'], 'application/problem+json');
      assert.strictEqual(res.body.detail, 'The request body is not valid JSON');
    });

    it('GET record is public', async () => {
      await start(null); // no actor at all
      await t.store.write((tx) => tx.run('INSERT INTO ch_records (name, version, body, sha256, record_version, at) VALUES (?, ?, ?, ?, 1, ?)',
        ['io.github.example/mod', '1.0.0', JSON.stringify(chRecord()), sha256Canonical(chRecord()), new Date().toISOString()]));
      const res = await request(t.url).get(recordPath('io.github.example/mod', '1.0.0')).expect(200);
      assert.deepStrictEqual(res.body, chRecord());
      await request(t.url).get(recordPath('io.github.example/mod', '9.9.9')).expect(404);
      await request(t.url).get(`/v0${recordPath('io.github.example/mod', '1.0.0').slice('/v0.1'.length)}`).expect(200);
    });

    it('after a record PUT, public reads of that name@version carry record {sha256, recordVersion} under our key', async () => {
      await start();
      const name = 'io.github.example/mod';
      const {body: {sha256}} = await put(name, '1.0.0', chRecord()).expect(201);
      await publish(server(name, '1.0.0', {_meta: pointer(name, '1.0.0', sha256)})).expect(200);
      await publish(server(name, '2.0.0')).expect(200);
      const v1 = await request(t.url).get(`/v0.1/servers/${encodeURIComponent(name)}/versions/1.0.0`).expect(200);
      assert.deepStrictEqual(v1.body._meta[OURS].record, {sha256, recordVersion: 1});
      const v2 = await request(t.url).get(`/v0.1/servers/${encodeURIComponent(name)}/versions/2.0.0`).expect(200);
      assert.strictEqual('record' in v2.body._meta[OURS], false);
      const list = await request(t.url).get('/v0.1/servers?search=example%2Fmod').expect(200);
      assert.deepStrictEqual(list.body.servers.map((s) => s._meta[OURS].record), [{sha256, recordVersion: 1}, undefined]);
    });
  });

  describe('validate endpoint', () => {
    const validate = (body) => request(t.url).post('/v0.1/validate').set('Content-Type', 'application/json').send(JSON.stringify(body));

    it('validate endpoint returns 200 {valid, issues} and 422 for a non-ServerDetail body', async () => {
      await start(null); // public, as upstream's
      const ok = await validate(server('io.github.example/weather', '1.0.0')).expect(200);
      assert.deepStrictEqual(ok.body, {valid: true, issues: []});
      const bad = await validate(server('io.github.example/weather', '^1')).expect(200);
      assert.strictEqual(bad.body.valid, false);
      assert.ok(bad.body.issues.some((i) => i.reference === 'version-looks-like-range'));
      // A non-current schema is a warning there, as upstream's ValidationAll.
      const old = await validate(server('io.github.example/weather', '1.0.0', {$schema: 'https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json'})).expect(200);
      assert.strictEqual(old.body.valid, true);
      assert.strictEqual(old.body.issues[0].severity, 'warning');
      const extra = await validate(server('io.github.example/weather', '1.0.0', {unknownField: 1})).expect(422);
      assert.strictEqual(extra.body.detail, 'validation failed');
      assert.strictEqual(extra.body.errors[0].location, 'body.unknownField');
      for (const b of [[], 'x', null]) await validate(b).expect(422);
      await request(t.url).post('/v0/validate').set('Content-Type', 'application/json').send(JSON.stringify(server('io.github.example/ws', '1.0.0'))).expect(200);
    });
  });
});
