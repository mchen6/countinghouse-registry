'use strict';
// Several upstreams (spec section 6.8): copies per upstream, the served record a
// projection of them, first in the list wins.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const {openStore} = require('../lib/store');
const {createLogger} = require('../lib/log');
const {runSync, mirrorState, mirrorSummary} = require('../lib/mirror/sync');
const {applyUpstreams} = require('../lib/mirror/sources');
const {toServerResponse} = require('../lib/read/response');

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const A = {name: 'a', url: 'https://a.example'};
const B = {name: 'b', url: 'https://b.example'};

function rec(name, version, o = {}) {
  const t = o.publishedAt || '2026-11-01T00:00:00.000000Z';
  return {
    server: {$schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', name, description: o.description || 'd', version},
    _meta: {[OFFICIAL]: {status: o.status || 'active', statusChangedAt: t, publishedAt: t, updatedAt: o.updatedAt || t, isLatest: o.isLatest ?? true}}
  };
}

// One page of records, or several when given an array of arrays.
function client(...pages) {
  const calls = [];
  const map = {};
  pages.forEach((servers, i) => { map[i ? `c${i}` : ''] = {servers, nextCursor: i + 1 < pages.length ? `c${i + 1}` : null}; });
  return {calls, page: async ({cursor = null} = {}) => { calls.push(cursor); return map[cursor || '']; }, version: async () => null};
}

describe('several upstreams', () => {
  let dir;
  let store;
  let log;
  let clock;
  const now = () => new Date(clock);
  const sync = (upstream, c, o = {}) => runSync(store, c, log, {upstream, now, ...o});
  const served = async (name) => (await store.read('SELECT version, server, official, upstream, hidden_reason FROM records WHERE name = ? ORDER BY version', [name]))
    .map((r) => ({version: r.version, description: JSON.parse(r.server).description, status: JSON.parse(r.official).status,
      isLatest: JSON.parse(r.official).isLatest, upstream: r.upstream, hidden: r.hidden_reason}));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-sources-'));
    store = await openStore(path.join(dir, 'r.db'));
    log = createLogger({stream: {write: () => true}});
    clock = Date.parse('2026-11-10T10:00:00.000Z');
    await applyUpstreams(store, [A, B], now().toISOString());
  });
  afterEach(async () => { await store.close(); fs.rmSync(dir, {recursive: true, force: true}); });

  it("the first upstream's copy is served", async () => {
    await sync('b', client([rec('x/s', '1.0.0', {description: 'from b'})]));
    await sync('a', client([rec('x/s', '1.0.0', {description: 'from a'})]));
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.description, r.upstream]), [['from a', 'a']]);
  });

  it('the first upstream wins whichever order the runs come in', async () => {
    await sync('a', client([rec('x/s', '1.0.0', {description: 'from a'})]));
    await sync('b', client([rec('x/s', '1.0.0', {description: 'from b'})]));
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.description, r.upstream]), [['from a', 'a']]);
  });

  it('a copy only the second upstream has is served from it', async () => {
    await sync('a', client([rec('x/s', '1.0.0')]));
    await sync('b', client([rec('y/s', '1.0.0')]));
    assert.deepStrictEqual((await served('y/s')).map((r) => r.upstream), ['b']);
  });

  it('a copy gone from the first upstream falls back to the second', async () => {
    await sync('a', client([rec('x/s', '1.0.0', {description: 'from a'}), rec('z/s', '1.0.0')]));
    await sync('b', client([rec('x/s', '1.0.0', {description: 'from b'})]));
    clock += 3600000;
    await sync('a', client([rec('z/s', '1.0.0')]), {mode: 'reconcile'});
    assert.deepStrictEqual(await served('x/s'), [{version: '1.0.0', description: 'from b', status: 'active', isLatest: true, upstream: 'b', hidden: null}]);
  });

  it('a record is hidden only when no upstream has it', async () => {
    await sync('a', client([rec('x/s', '1.0.0'), rec('z/s', '1.0.0')]));
    await sync('b', client([rec('x/s', '1.0.0'), rec('z/s', '1.0.0')]));
    clock += 3600000;
    await sync('a', client([rec('z/s', '1.0.0')]), {mode: 'reconcile'});
    assert.strictEqual((await served('x/s'))[0].hidden, null);
    await sync('b', client([rec('z/s', '1.0.0')]), {mode: 'reconcile'});
    const [x] = await served('x/s');
    assert.strictEqual(x.hidden, 'gone-upstream');
    assert.strictEqual(x.upstream, null);
  });

  it('a deleted copy at the first upstream is served as deleted', async () => {
    await sync('b', client([rec('x/s', '1.0.0')]));
    await sync('a', client([rec('x/s', '1.0.0', {status: 'deleted'})]));
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.status, r.upstream]), [['deleted', 'a']]);
  });

  it("isLatest is the upstream's own when one upstream serves every version", async () => {
    // Upstream says 1.0.0 is latest (its own rule would say 2.0.0): served as it is.
    await sync('a', client([rec('x/s', '1.0.0', {isLatest: true}), rec('x/s', '2.0.0', {isLatest: false})]));
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.version, r.isLatest]), [['1.0.0', true], ['2.0.0', false]]);
  });

  it('isLatest is recomputed over the union when two upstreams serve the name', async () => {
    await sync('a', client([rec('x/s', '1.0.0', {isLatest: true})]));
    await sync('b', client([rec('x/s', '2.0.0', {isLatest: true}), rec('x/s', '1.0.0', {isLatest: false})]));
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.version, r.upstream, r.isLatest]), [['1.0.0', 'a', false], ['2.0.0', 'b', true]]);
  });

  it('a deleted version does not win the recomputed isLatest unless all are deleted', async () => {
    await sync('a', client([rec('x/s', '1.0.0')]));
    await sync('b', client([rec('x/s', '2.0.0', {status: 'deleted'})]));
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.version, r.isLatest]), [['1.0.0', true], ['2.0.0', false]]);
  });

  it('isLatest goes back to the upstream\'s own when the name is served from one upstream again', async () => {
    await sync('a', client([rec('x/s', '1.0.0', {isLatest: true}), rec('x/s', '0.9.0', {isLatest: false})]));
    await sync('b', client([rec('x/s', '2.0.0'), rec('z/s', '1.0.0')]));
    clock += 3600000;
    await sync('b', client([rec('z/s', '1.0.0')]), {mode: 'reconcile'});
    const rows = (await served('x/s')).filter((r) => !r.hidden);
    assert.deepStrictEqual(rows.map((r) => [r.version, r.isLatest]), [['0.9.0', false], ['1.0.0', true]]);
  });

  it('a version no upstream serves any more is not latest while another version is served', async () => {
    await sync('a', client([rec('x/s', '1.0.0', {isLatest: true})]));
    await sync('b', client([rec('x/s', '2.0.0', {isLatest: true})]));
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.version, r.isLatest]), [['1.0.0', false], ['2.0.0', true]]);
    await applyUpstreams(store, [A], now().toISOString());
    assert.deepStrictEqual((await served('x/s')).map((r) => [r.version, r.isLatest, r.hidden]), [['1.0.0', true, null], ['2.0.0', false, 'gone-upstream']]);
  });

  it('the public summary has no lag when any upstream has no lag', () => {
    const s = mirrorSummary({upstreams: [
      {name: 'a', state: 'idle', lastSuccessAt: '2026-11-10T10:00:00.000Z', lag: 60, lastError: null, upstreamVersion: null},
      {name: 'b', state: 'idle', lastSuccessAt: '2026-11-10T09:00:00.000Z', lag: null, lastError: null, upstreamVersion: null}]});
    assert.deepStrictEqual(s, {state: 'idle', lastSuccessAt: '2026-11-10T09:00:00.000Z', lag: null, upstreams: 2});
  });

  it('the shrink guard and the pass count are per upstream', async () => {
    const many = Array.from({length: 6}, (_, i) => rec(`n${i}/s`, '1.0.0'));
    await sync('a', client(many));
    await sync('b', client([rec('only/b', '1.0.0')]));
    clock += 3600000;
    // b's pass sees the 1 record it saw before: it is not judged against a's 6.
    const rb = await sync('b', client([rec('only/b', '1.0.0')]), {mode: 'reconcile'});
    assert.strictEqual(rb.state, 'idle');
    const ra = await sync('a', client(many.slice(0, 2)), {mode: 'reconcile'});
    assert.strictEqual(ra.state, 'failed');
    const st = await mirrorState(store, now());
    assert.deepStrictEqual(st.upstreams.map((u) => [u.name, u.state, u.lastError]), [['a', 'failed', 'upstream-shrank'], ['b', 'idle', null]]);
  });

  it('public reads show origin mirror and nothing about the upstream', async () => {
    await sync('b', client([rec('x/s', '1.0.0')]));
    const [row] = await store.read("SELECT * FROM records WHERE name = 'x/s'");
    assert.strictEqual(row.upstream, 'b');
    const served = toServerResponse(row);
    assert.strictEqual(served._meta['io.github.mchen6/countinghouse-registry'].origin, 'mirror');
    assert.ok(!JSON.stringify(served).includes('"b"') && !JSON.stringify(served).includes('upstream'), JSON.stringify(served));
  });

  it('a page applies the projection in the same transaction as the copies', async () => {
    const realWrite = store.write;
    const seen = [];
    store.write = (fn) => realWrite(async (tx) => {
      const out = await fn(tx);
      seen.push((await tx.get("SELECT count(*) AS n FROM records WHERE name = 'x/s'")).n);
      return out;
    });
    await sync('a', client([rec('x/s', '1.0.0')]));
    store.write = realWrite;
    assert.ok(seen.includes(1), 'the served record was not written inside the page transaction');
  });

  describe('applyUpstreams', () => {
    it('a changed order rebuilds every served record', async () => {
      await sync('a', client([rec('x/s', '1.0.0', {description: 'from a'})]));
      await sync('b', client([rec('x/s', '1.0.0', {description: 'from b'})]));
      await applyUpstreams(store, [B, A], now().toISOString());
      assert.deepStrictEqual((await served('x/s')).map((r) => [r.description, r.upstream]), [['from b', 'b']]);
      const st = await mirrorState(store, now());
      assert.deepStrictEqual(st.upstreams.map((u) => u.name), ['b', 'a']);
    });

    it('a removed upstream loses its copies; records only it had are hidden, not removed', async () => {
      await sync('a', client([rec('x/s', '1.0.0'), rec('only/a', '1.0.0')]));
      await sync('b', client([rec('x/s', '1.0.0')]));
      await applyUpstreams(store, [B], now().toISOString());
      assert.deepStrictEqual((await served('x/s')).map((r) => [r.upstream, r.hidden]), [['b', null]]);
      assert.deepStrictEqual((await served('only/a')).map((r) => [r.upstream, r.hidden]), [[null, 'gone-upstream']]);
      const [{n}] = await store.read("SELECT count(*) AS n FROM record_sources WHERE upstream = 'a'");
      assert.strictEqual(n, 0);
      assert.deepStrictEqual((await mirrorState(store, now())).upstreams.map((u) => u.name), ['b']);
    });

    it('a changed url is a different registry: its copies and state go, and it starts with a first sync', async () => {
      await sync('a', client([rec('x/s', '1.0.0', {description: 'from a', updatedAt: '2026-11-05T00:00:00.000000Z'}), rec('only/a', '1.0.0')]));
      await sync('b', client([rec('x/s', '1.0.0', {description: 'from b'})]));
      await applyUpstreams(store, [{...A, url: 'https://a2.example'}, B], now().toISOString());
      const [u] = await store.read(`SELECT first_sync_done, checkpoint, cursor, last_success_at, success_started, upstream_version
        FROM mirror_upstreams WHERE name = 'a'`);
      assert.deepStrictEqual(u, {first_sync_done: 0, checkpoint: null, cursor: null, last_success_at: null, success_started: null, upstream_version: null});
      assert.deepStrictEqual((await served('x/s')).map((r) => [r.description, r.upstream]), [['from b', 'b']]);
      assert.deepStrictEqual((await served('only/a')).map((r) => r.hidden), ['gone-upstream']);
      // The new registry's copy is served even though its updatedAt is older than the old registry's was.
      await sync('a', client([rec('x/s', '1.0.0', {description: 'from a2', updatedAt: '2026-10-01T00:00:00.000000Z'})]));
      assert.deepStrictEqual((await served('x/s')).map((r) => [r.description, r.upstream]), [['from a2', 'a']]);
    });

    it('a url that differs only by a trailing slash is not a change', async () => {
      await sync('a', client([rec('x/s', '1.0.0')]));
      await applyUpstreams(store, [{...A, url: 'https://a.example/'}, B], now().toISOString());
      const [u] = await store.read("SELECT first_sync_done FROM mirror_upstreams WHERE name = 'a'");
      assert.strictEqual(u.first_sync_done, 1);
    });

    it('an unchanged list changes nothing', async () => {
      await sync('a', client([rec('x/s', '1.0.0')]));
      const [before] = await store.read("SELECT changed_at FROM records WHERE name = 'x/s'");
      clock += 3600000;
      await applyUpstreams(store, [A, B], now().toISOString());
      const [after] = await store.read("SELECT changed_at FROM records WHERE name = 'x/s'");
      assert.strictEqual(after.changed_at, before.changed_at);
      const [u] = await store.read("SELECT first_sync_done FROM mirror_upstreams WHERE name = 'a'");
      assert.strictEqual(u.first_sync_done, 1);
    });
  });
});

describe('migration 003', () => {
  it("moves schema 2's mirror rows and state to the upstream official", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-mig3-'));
    const file = path.join(dir, 'r.db');
    const migrations = path.join(__dirname, '..', 'lib', 'store', 'migrations');
    const sql = ['001-initial.sql', '002-reconcile-stage.sql'].map((f) => fs.readFileSync(path.join(migrations, f), 'utf8')).join('\n');
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(file);
      db.exec(`${sql}
        INSERT INTO records (source, name, version, server, official, origin, changed_at, mirrored_at, upstream_updated_at, seen_pass)
          VALUES ('mirror', 'x/s', '1.0.0', '{"name":"x/s"}', '{"status":"active"}', 'mirror', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '2026-11-01T00:00:00Z', 3);
        UPDATE mirror_state SET checkpoint = '2026-11-10T00:00:00.000Z', first_sync_done = 1, pass_no = 3, last_pass_count = 1 WHERE id = 1;
        INSERT INTO meta_kv (k, v) VALUES ('mirror_success_started', '2026-11-10T00:00:00.000Z');
        INSERT INTO meta_kv (k, v) VALUES ('schema_version', '2');`, (err) => db.close(() => (err ? reject(err) : resolve())));
    });
    const store = await openStore(file);
    try {
      const [u] = await store.read("SELECT name, checkpoint, first_sync_done, pass_no, last_pass_count, success_started FROM mirror_upstreams");
      assert.deepStrictEqual(u, {name: 'official', checkpoint: '2026-11-10T00:00:00.000Z', first_sync_done: 1, pass_no: 3, last_pass_count: 1, success_started: '2026-11-10T00:00:00.000Z'});
      const src = await store.read('SELECT upstream, name, version, seen_pass FROM record_sources');
      assert.deepStrictEqual(src, [{upstream: 'official', name: 'x/s', version: '1.0.0', seen_pass: 3}]);
      const [{url}] = await store.read('SELECT url FROM mirror_upstreams');
      assert.strictEqual(url, 'https://registry.modelcontextprotocol.io', 'a url change at upgrade would go unnoticed');
      const [r] = await store.read('SELECT upstream FROM records');
      assert.strictEqual(r.upstream, 'official');
      assert.deepStrictEqual(await store.read("SELECT k FROM meta_kv WHERE k LIKE 'mirror_%'"), []);
    } finally {
      await store.close();
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
