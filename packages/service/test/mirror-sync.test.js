'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {openStore} = require('../lib/store');
const {createLogger} = require('../lib/log');
const {runSync, mirrorState} = require('../lib/mirror/sync');
const {UpstreamError} = require('../lib/mirror/client');

const OFFICIAL = 'io.modelcontextprotocol.registry/official';

function rec(name, version, o = {}) {
  const t = o.updatedAt || '2026-11-01T00:00:00.000000Z';
  return {
    server: {$schema: o.schema || 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', name, description: 'd', version},
    _meta: {[OFFICIAL]: {status: o.status || 'active', statusChangedAt: t, publishedAt: t, updatedAt: t, isLatest: true}}
  };
}

// A fake upstream: `pages` maps a cursor ('' for the first page) to {servers, nextCursor}.
function fakeClient(pages, {failOn = null, version = '1.8.9'} = {}) {
  const calls = [];
  return {
    calls,
    page: async ({cursor = null, updatedSince = null} = {}) => {
      calls.push({cursor, updatedSince});
      const key = cursor || '';
      if (failOn !== null && failOn === key) throw new UpstreamError('http-5xx', 503);
      return pages[key];
    },
    version: async () => version
  };
}

describe('mirror sync', () => {
  let dir;
  let store;
  let lines;
  let log;
  let clock;
  const now = () => new Date(clock);
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-sync-'));
    store = await openStore(path.join(dir, 'r.db'));
    lines = [];
    log = createLogger({stream: {write: (s) => { lines.push(s); return true; }}});
    clock = Date.parse('2026-11-10T10:00:00.000Z');
  });
  afterEach(async () => { await store.close(); fs.rmSync(dir, {recursive: true, force: true}); });

  const names = async () => (await store.read('SELECT name, version FROM records ORDER BY name, version')).map((r) => `${r.name}@${r.version}`);
  const three = () => ({
    '': {servers: [rec('a/x', '1'), rec('b/x', '1')], nextCursor: 'c1'},
    c1: {servers: [rec('c/x', '1')], nextCursor: 'c2'},
    c2: {servers: [rec('d/x', '1')], nextCursor: null}
  });

  it('first sync streams pages into the store and serves what is loaded', async () => {
    const pages = three();
    const client = fakeClient(pages);
    let seenAfterFirst = null;
    let stateAfterFirst = null;
    const orig = client.page;
    client.page = async (args) => {
      if (args.cursor === 'c1') {
        seenAfterFirst = await names();
        stateAfterFirst = (await mirrorState(store, now())).state;
      }
      return orig(args);
    };
    const r = await runSync(store, client, log, {now});
    assert.strictEqual(r.state, 'idle');
    assert.deepStrictEqual(seenAfterFirst, ['a/x@1', 'b/x@1']);
    assert.strictEqual(stateAfterFirst, 'syncing');
    assert.deepStrictEqual(await names(), ['a/x@1', 'b/x@1', 'c/x@1', 'd/x@1']);
  });

  it('resumes after a crash between pages', async () => {
    const pages = three();
    const r1 = await runSync(store, fakeClient(pages, {failOn: 'c2'}), log, {now});
    assert.strictEqual(r1.state, 'failed');
    const client = fakeClient(pages);
    const r2 = await runSync(store, client, log, {now});
    assert.strictEqual(r2.state, 'idle');
    assert.strictEqual(client.calls[0].cursor, 'c2', 'did not resume from the stored cursor');
    assert.deepStrictEqual(await names(), ['a/x@1', 'b/x@1', 'c/x@1', 'd/x@1']);
  });

  it('takes the checkpoint at the start of the first sync and commits it only after the last page', async () => {
    const pages = three();
    const client = fakeClient(pages, {failOn: 'c2'});
    await runSync(store, client, log, {now});
    let [st] = await store.read('SELECT checkpoint, first_sync_done FROM mirror_state');
    assert.strictEqual(st.checkpoint, null);
    assert.strictEqual(st.first_sync_done, 0);
    const started = clock;
    clock += 3600000;
    await runSync(store, fakeClient(pages), log, {now});
    [st] = await store.read('SELECT checkpoint, first_sync_done FROM mirror_state');
    assert.strictEqual(st.checkpoint, new Date(started).toISOString(), 'checkpoint is not the start of the first sync');
    assert.strictEqual(st.first_sync_done, 1);
  });

  it('incremental uses checkpoint minus 5 minutes and the same value on every page', async () => {
    await runSync(store, fakeClient(three()), log, {now});
    clock += 3600000;
    const client = fakeClient({'': {servers: [rec('e/x', '1')], nextCursor: 'i1'}, i1: {servers: [], nextCursor: null}});
    await runSync(store, client, log, {now});
    const since = new Date(Date.parse('2026-11-10T10:00:00.000Z') - 300000).toISOString();
    assert.deepStrictEqual(client.calls.map((c) => c.updatedSince), [since, since]);
    const [st] = await store.read('SELECT checkpoint FROM mirror_state');
    assert.strictEqual(st.checkpoint, '2026-11-10T11:00:00.000Z');
  });

  it('replaces a record only when upstream updatedAt is not older', async () => {
    await runSync(store, fakeClient({'': {servers: [rec('a/x', '1', {updatedAt: '2026-11-05T00:00:00.000001Z'})], nextCursor: null}}), log, {now});
    clock += 3600000;
    const older = rec('a/x', '1', {updatedAt: '2026-11-04T00:00:00Z'});
    older.server.description = 'stale';
    await runSync(store, fakeClient({'': {servers: [older], nextCursor: null}}), log, {now});
    let [row] = await store.read("SELECT server, changed_at FROM records WHERE name = 'a/x'");
    assert.strictEqual(JSON.parse(row.server).description, 'd');
    assert.strictEqual(row.changed_at, '2026-11-10T10:00:00.000Z', 'a stale copy moved changed_at');
    clock += 3600000;
    const newer = rec('a/x', '1', {updatedAt: '2026-11-06T00:00:00Z'});
    newer.server.description = 'fresh';
    await runSync(store, fakeClient({'': {servers: [newer], nextCursor: null}}), log, {now});
    [row] = await store.read("SELECT server, changed_at FROM records WHERE name = 'a/x'");
    assert.strictEqual(JSON.parse(row.server).description, 'fresh');
    assert.strictEqual(row.changed_at, '2026-11-10T12:00:00.000Z');
  });

  it('an identical copy does not move changed_at', async () => {
    const pages = {'': {servers: [rec('a/x', '1')], nextCursor: null}};
    await runSync(store, fakeClient(pages), log, {now});
    clock += 3600000;
    await runSync(store, fakeClient(pages), log, {now});
    const [row] = await store.read("SELECT changed_at FROM records WHERE name = 'a/x'");
    assert.strictEqual(row.changed_at, '2026-11-10T10:00:00.000Z');
  });

  it('applies deleted status from incremental results', async () => {
    await runSync(store, fakeClient({'': {servers: [rec('a/x', '1')], nextCursor: null}}), log, {now});
    clock += 3600000;
    await runSync(store, fakeClient({'': {servers: [rec('a/x', '1', {status: 'deleted', updatedAt: '2026-11-10T10:30:00Z'})], nextCursor: null}}), log, {now});
    const [row] = await store.read("SELECT official FROM records WHERE name = 'a/x'");
    assert.strictEqual(JSON.parse(row.official).status, 'deleted');
  });

  it('stores mirrored server objects as served, without validation', async () => {
    const old = rec('a/x', '1', {schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json'});
    old.server.description = 'x'.repeat(500);
    await runSync(store, fakeClient({'': {servers: [old], nextCursor: null}}), log, {now});
    const [row] = await store.read("SELECT server, official, origin, source FROM records WHERE name = 'a/x'");
    assert.deepStrictEqual(JSON.parse(row.server), old.server);
    assert.deepStrictEqual(JSON.parse(row.official), old._meta[OFFICIAL]);
    assert.strictEqual(row.origin, 'mirror');
    assert.strictEqual(row.source, 'mirror');
  });

  it('never overwrites a local record', async () => {
    await store.write((tx) => tx.run(`INSERT INTO records (source, name, version, server, official, origin, changed_at)
      VALUES ('local', 'a/x', '1', '{"name":"a/x"}', '{}', 'local', 't0')`));
    await runSync(store, fakeClient({'': {servers: [rec('a/x', '1')], nextCursor: null}}), log, {now});
    const [row] = await store.read("SELECT source, server FROM records WHERE name = 'a/x'");
    assert.strictEqual(row.source, 'local');
    assert.strictEqual(row.server, '{"name":"a/x"}');
  });

  it('reconcile hides records not seen in the pass as gone-upstream', async () => {
    await runSync(store, fakeClient(three()), log, {now});
    clock += 3600000;
    const pages = {'': {servers: [rec('a/x', '1'), rec('b/x', '1')], nextCursor: 'c1'}, c1: {servers: [rec('c/x', '1')], nextCursor: null}};
    const r = await runSync(store, fakeClient(pages), log, {now, mode: 'reconcile'});
    assert.strictEqual(r.state, 'idle');
    const rows = await store.read('SELECT name, hidden_reason, changed_at FROM records ORDER BY name');
    assert.deepStrictEqual(rows.map((x) => [x.name, x.hidden_reason]), [['a/x', null], ['b/x', null], ['c/x', null], ['d/x', 'gone-upstream']]);
    assert.strictEqual(rows[3].changed_at, '2026-11-10T11:00:00.000Z');
  });

  it('a record seen again after being gone is shown again', async () => {
    await runSync(store, fakeClient(three()), log, {now});
    clock += 3600000;
    await runSync(store, fakeClient({'': {servers: [rec('a/x', '1'), rec('b/x', '1'), rec('c/x', '1')], nextCursor: null}}), log, {now, mode: 'reconcile'});
    clock += 3600000;
    await runSync(store, fakeClient(three()), log, {now, mode: 'reconcile'});
    const [row] = await store.read("SELECT hidden_reason FROM records WHERE name = 'd/x'");
    assert.strictEqual(row.hidden_reason, null);
  });

  it('reconcile that sees fewer than half the previous count hides nothing and fails with upstream-shrank', async () => {
    await runSync(store, fakeClient(three()), log, {now});
    clock += 3600000;
    const r = await runSync(store, fakeClient({'': {servers: [rec('a/x', '1')], nextCursor: null}}), log, {now, mode: 'reconcile'});
    assert.strictEqual(r.state, 'failed');
    const st = await mirrorState(store, now());
    assert.strictEqual(st.lastError, 'upstream-shrank');
    const hidden = await store.read('SELECT name FROM records WHERE hidden_reason IS NOT NULL');
    assert.deepStrictEqual(hidden, []);
  });

  it('a failed run leaves the checkpoint unchanged and sets lastError', async () => {
    await runSync(store, fakeClient(three()), log, {now});
    clock += 3600000;
    const r = await runSync(store, fakeClient({}, {failOn: ''}), log, {now});
    assert.strictEqual(r.state, 'failed');
    const [st] = await store.read('SELECT checkpoint FROM mirror_state');
    assert.strictEqual(st.checkpoint, '2026-11-10T10:00:00.000Z');
    const m = await mirrorState(store, now());
    assert.strictEqual(m.state, 'failed');
    assert.strictEqual(m.lastError, 'http-5xx');
    assert.strictEqual(m.lastSuccessAt, '2026-11-10T10:00:00.000Z');
  });

  it('mirror state reports lag from the start of the last successful run and the upstream version', async () => {
    await runSync(store, fakeClient(three(), {version: '1.8.9'}), log, {now});
    clock += 120000;
    const m = await mirrorState(store, now());
    assert.deepStrictEqual(m, {state: 'idle', lastSuccessAt: '2026-11-10T10:00:00.000Z', lag: 120, lastError: null, upstreamVersion: '1.8.9'});
  });

  it('stops between pages when asked, keeping its place', async () => {
    let stop = false;
    const client = fakeClient(three());
    const orig = client.page;
    client.page = async (a) => { const p = await orig(a); stop = true; return p; };
    const r = await runSync(store, client, log, {now, shouldStop: () => stop});
    assert.strictEqual(r.state, 'syncing');
    assert.strictEqual(client.calls.length, 1);
    const r2 = await runSync(store, fakeClient(three()), log, {now});
    assert.strictEqual(r2.state, 'idle');
    assert.deepStrictEqual(await names(), ['a/x@1', 'b/x@1', 'c/x@1', 'd/x@1']);
  });

  it('logs the upstream status and page number, nothing from the body', async () => {
    const pages = three();
    await runSync(store, fakeClient(pages, {failOn: 'c1'}), log, {now});
    const failed = lines.map((l) => JSON.parse(l)).find((r) => r.event === 'mirror.failed');
    assert.ok(failed, lines.join(''));
    assert.strictEqual(failed.status, 503);
    assert.strictEqual(failed.page, 2);
    assert.ok(!lines.join('').includes('a/x'), 'a record name reached the log');
  });
});
