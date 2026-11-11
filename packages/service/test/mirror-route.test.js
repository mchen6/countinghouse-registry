'use strict';
const assert = require('assert');
const request = require('supertest');
const {startApp} = require('./support/app');

const X = '/x/io.github.mchen6/countinghouse-registry';

describe('mirror route', () => {
  let t;
  beforeEach(async () => { t = await startApp(); });
  afterEach(async () => { await t.close(); });

  it('serves the mirror state publicly under /v0.1 and /v0, with CORS', async () => {
    await t.store.write((tx) => tx.run("UPDATE mirror_state SET state = 'idle', last_success_at = '2026-11-10T10:00:00.000Z', upstream_version = '1.8.9' WHERE id = 1"));
    for (const prefix of ['/v0.1', '/v0']) {
      const res = await request(t.url).get(`${prefix}${X}/mirror`).set('Origin', 'https://example.org').expect(200);
      assert.strictEqual(res.headers['content-type'], 'application/json');
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.deepStrictEqual(Object.keys(res.body).sort(), ['lag', 'lastError', 'lastSuccessAt', 'state', 'upstreamVersion']);
      assert.strictEqual(res.body.state, 'idle');
      assert.strictEqual(res.body.upstreamVersion, '1.8.9');
    }
  });

  it('healthz carries the mirror state', async () => {
    const res = await request(t.url).get('/healthz').expect(200);
    assert.strictEqual(res.body.mirror.state, 'idle');
  });

  it('a failed mirror alone does not make healthz 503', async () => {
    await t.store.write((tx) => tx.run("UPDATE mirror_state SET state = 'failed', last_error = 'http-5xx' WHERE id = 1"));
    const res = await request(t.url).get('/healthz').expect(200);
    assert.strictEqual(res.body.mirror.lastError, 'http-5xx');
  });
});
