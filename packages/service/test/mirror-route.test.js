'use strict';
const assert = require('assert');
const request = require('supertest');
const {startApp} = require('./support/app');
const {applyUpstreams} = require('../lib/mirror/sources');

const X = '/x/io.github.mchen6/countinghouse-registry';

describe('mirror route', () => {
  let t;
  beforeEach(async () => {
    t = await startApp();
    await applyUpstreams(t.store, [{name: 'official', url: 'https://registry.example'}, {name: 'own-registry', url: 'https://own.example'}],
      '2026-11-10T00:00:00.000Z');
    await t.store.write(async (tx) => {
      await tx.run(`UPDATE mirror_upstreams SET state = 'idle', last_success_at = '2026-11-10T10:00:00.000Z', success_started = '2026-11-10T09:59:00.000Z',
        upstream_version = '1.8.9' WHERE name = 'official'`);
      await tx.run(`UPDATE mirror_upstreams SET state = 'syncing', last_success_at = '2026-11-10T08:00:00.000Z', success_started = '2026-11-10T07:59:00.000Z'
        WHERE name = 'own-registry'`);
    });
  });
  afterEach(async () => { await t.close(); });

  it('serves the public aggregate under /v0.1 and /v0, with CORS, naming no upstream', async () => {
    for (const prefix of ['/v0.1', '/v0']) {
      const res = await request(t.url).get(`${prefix}${X}/mirror`).set('Origin', 'https://example.org').expect(200);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.deepStrictEqual(Object.keys(res.body).sort(), ['lag', 'lastSuccessAt', 'state', 'upstreams']);
      assert.strictEqual(res.body.state, 'syncing', 'not the worst state across upstreams');
      assert.strictEqual(res.body.lastSuccessAt, '2026-11-10T08:00:00.000Z', 'not the oldest success');
      assert.strictEqual(res.body.upstreams, 2);
      assert.ok(!res.text.includes('own-registry') && !res.text.includes('example'), res.text);
    }
  });

  it('the aggregate state is failed when any upstream failed, and success unknown while one never succeeded', async () => {
    await t.store.write((tx) => tx.run("UPDATE mirror_upstreams SET state = 'failed', last_error = 'http-5xx', last_success_at = NULL, success_started = NULL WHERE name = 'official'"));
    const res = await request(t.url).get(`/v0.1${X}/mirror`).expect(200);
    assert.deepStrictEqual(res.body, {state: 'failed', lastSuccessAt: null, lag: null, upstreams: 2});
  });

  it('healthz carries the aggregate and the named per-upstream list, never a url', async () => {
    const res = await request(t.url).get('/healthz').expect(200);
    assert.strictEqual(res.body.mirror.state, 'syncing');
    assert.deepStrictEqual(res.body.upstreams.map((u) => [u.name, u.state, u.upstreamVersion]), [['official', 'idle', '1.8.9'], ['own-registry', 'syncing', null]]);
    assert.ok(!res.text.includes('example'), res.text);
  });

  it('a failed mirror alone does not make healthz 503', async () => {
    await t.store.write((tx) => tx.run("UPDATE mirror_upstreams SET state = 'failed', last_error = 'http-5xx' WHERE name = 'official'"));
    const res = await request(t.url).get('/healthz').expect(200);
    assert.strictEqual(res.body.upstreams[0].lastError, 'http-5xx');
    assert.strictEqual(res.body.mirror.state, 'failed');
  });
});
