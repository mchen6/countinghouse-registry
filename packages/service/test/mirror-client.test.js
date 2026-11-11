'use strict';
const assert = require('assert');
const {createUpstreamClient, UpstreamError} = require('../lib/mirror/client');

const UA = 'countinghouse-registry/0.1.0 (+https://github.com/mchen6/countinghouse-registry)';
const PAGE = {servers: [], metadata: {count: 0}};

function response(status, body, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: {get: (k) => headers[k.toLowerCase()] ?? null},
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function fake(script) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init});
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return {fetch, calls};
}

function client(f, extra = {}) {
  const sleeps = [];
  const c = createUpstreamClient({baseUrl: 'https://registry.example', fetch: f.fetch, userAgent: UA,
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 1, maxDelayMs: 60000, ...extra});
  return {c, sleeps};
}

describe('mirror client', () => {
  it('sends the decided User-Agent, limit=100, include_deleted=true and gzip', async () => {
    const f = fake([response(200, PAGE)]);
    const {c} = client(f);
    await c.page({cursor: 'a b', updatedSince: '2026-11-01T00:00:00.000Z'});
    const u = new URL(f.calls[0].url);
    assert.strictEqual(u.origin + u.pathname, 'https://registry.example/v0.1/servers');
    assert.strictEqual(u.searchParams.get('limit'), '100');
    assert.strictEqual(u.searchParams.get('include_deleted'), 'true');
    assert.strictEqual(u.searchParams.get('cursor'), 'a b');
    assert.strictEqual(u.searchParams.get('updated_since'), '2026-11-01T00:00:00.000Z');
    assert.strictEqual(f.calls[0].init.headers['User-Agent'], UA);
    assert.strictEqual(f.calls[0].init.headers['Accept-Encoding'], 'gzip');
  });

  it('returns servers and nextCursor', async () => {
    const rec = {server: {name: 'a/x', version: '1'}, _meta: {'io.modelcontextprotocol.registry/official': {status: 'active'}}};
    const f = fake([response(200, {servers: [rec], metadata: {count: 1, nextCursor: 'n1'}})]);
    const {c} = client(f);
    assert.deepStrictEqual(await c.page({}), {servers: [rec], nextCursor: 'n1'});
  });

  it("honours Retry-After on 429 and never retries in a tight loop", async () => {
    const f = fake([response(429, '', {'retry-after': '7'}), response(200, PAGE)]);
    const {c, sleeps} = client(f);
    await c.page({});
    assert.deepStrictEqual(sleeps, [7000]);
  });

  it('backs off with full jitter on 503, from 5 s, capped', async () => {
    const f = fake([response(503, ''), response(503, ''), response(503, ''), response(200, PAGE)]);
    const {c, sleeps} = client(f, {random: () => 0.5});
    await c.page({});
    assert.deepStrictEqual(sleeps, [2500, 5000, 10000]);
  });

  it('retries a network error', async () => {
    const f = fake([Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}), response(200, PAGE)]);
    const {c, sleeps} = client(f);
    await c.page({});
    assert.strictEqual(sleeps.length, 1);
  });

  it('gives up after maxDelayMs of waiting with the error code', async () => {
    const f = fake(Array(20).fill(null).map(() => response(503, '')));
    const {c} = client(f, {maxDelayMs: 20000});
    await assert.rejects(c.page({}), (err) => err instanceof UpstreamError && err.code === 'http-5xx' && err.status === 503);
  });

  it('rejects a page whose body is not {servers: [], metadata: {}}', async () => {
    for (const body of ['not json', {servers: 'x', metadata: {}}, {servers: []}, {servers: [{server: {}}], metadata: {}}]) {
      const f = fake([response(200, body)]);
      const {c} = client(f);
      await assert.rejects(c.page({}), (err) => err.code === 'bad-page', JSON.stringify(body));
    }
  });

  it('does not retry another 4xx', async () => {
    const f = fake([response(404, '')]);
    const {c, sleeps} = client(f);
    await assert.rejects(c.page({}), (err) => err.code === 'http-4xx' && err.status === 404);
    assert.deepStrictEqual(sleeps, []);
  });

  it('reads the upstream version, or null when it does not answer', async () => {
    let f = fake([response(200, {version: '1.8.9', git_commit: 'x', build_time: 'y'})]);
    assert.strictEqual(await client(f).c.version(), '1.8.9');
    f = fake([response(500, '')]);
    assert.strictEqual(await client(f).c.version(), null);
  });
});
