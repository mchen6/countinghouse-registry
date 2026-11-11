'use strict';
// Local precedence in claimed namespaces (spec sections 7.2-7.4, 13.3): what the
// mirror does to a name that has local records, and isLatest over both.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {openStore} = require('../lib/store');
const {createLogger} = require('../lib/log');
const {runSync} = require('../lib/mirror/sync');
const {applyUpstreams} = require('../lib/mirror/sources');
const {publishServer} = require('../lib/publish/publish');
const {applyClaims, ClaimError} = require('../lib/publish/namespaces');
const {publisher} = require('./support/auth');

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const NS = 'io.github.example/';

const server = (name, version, extra = {}) => ({$schema: SCHEMA, name, description: 'A test server', version, ...extra});

function rec(name, version, o = {}) {
  const t = o.publishedAt || '2026-11-01T00:00:00.000000Z';
  const official = {status: o.status || 'active', statusChangedAt: o.statusChangedAt || t, publishedAt: t, updatedAt: o.updatedAt || t, isLatest: o.isLatest ?? true};
  if (o.statusMessage) official.statusMessage = o.statusMessage;
  return {server: server(name, version, o.server || {}), _meta: {[OFFICIAL]: official}};
}

const client = (servers) => ({page: async () => ({servers, nextCursor: null}), version: async () => null});

describe('local precedence', () => {
  let dir;
  let store;
  let lines;
  let log;
  let clock;
  const now = () => new Date(clock);
  const tick = () => { clock += 1000; };
  const sync = (servers) => runSync(store, client(servers), log, {upstream: 'official', now});
  const publish = (doc) => publishServer(store, doc, publisher([NS]), {claims: [NS], now: now()});
  const rows = async (name) => (await store.read('SELECT version, source, origin, mirrored_at, server, official, changed_at FROM records WHERE name = ? ORDER BY version', [name]))
    .map((r) => ({...r, official: JSON.parse(r.official), server: JSON.parse(r.server)}));
  const latest = async (name) => (await rows(name)).filter((r) => r.official.isLatest).map((r) => r.version);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-prec-'));
    store = await openStore(path.join(dir, 'r.db'));
    lines = [];
    log = createLogger({stream: {write: (s) => { lines.push(JSON.parse(s)); return true; }}});
    clock = Date.parse('2026-11-10T10:00:00.000Z');
    await applyUpstreams(store, [{name: 'official', url: 'https://registry.example'}], now().toISOString());
    await applyClaims(store, [NS], now().toISOString());
  });
  afterEach(async () => { await store.close(); fs.rmSync(dir, {recursive: true, force: true}); });

  it('identical upstream copy of a local record becomes local+upstream with mirroredAt', async () => {
    await publish(server('io.github.example/ws', '1.0.0'));
    const before = (await rows('io.github.example/ws'))[0];
    tick();
    await sync([rec('io.github.example/ws', '1.0.0')]);
    const [r] = await rows('io.github.example/ws');
    assert.strictEqual(r.source, 'local');
    assert.strictEqual(r.origin, 'local+upstream');
    assert.ok(r.mirrored_at);
    assert.deepStrictEqual(r.official.publishedAt, before.official.publishedAt, 'our values stay');
    assert.ok(r.changed_at > before.changed_at);
  });

  it('different upstream copy records a conflict once and keeps the local record', async () => {
    await publish(server('io.github.example/ws', '1.0.0'));
    tick();
    await sync([rec('io.github.example/ws', '1.0.0', {server: {description: 'someone else'}})]);
    tick();
    await sync([rec('io.github.example/ws', '1.0.0', {server: {description: 'someone else'}})]);
    const [r] = await rows('io.github.example/ws');
    assert.strictEqual(r.origin, 'local');
    assert.strictEqual(r.server.description, 'A test server');
    const conflicts = await store.read('SELECT name, version, local_sha, upstream_sha, first_seen FROM conflicts');
    assert.strictEqual(conflicts.length, 1);
    assert.match(conflicts[0].local_sha, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(conflicts[0].local_sha, conflicts[0].upstream_sha);
    const warned = lines.filter((l) => l.event === 'publish.conflict');
    assert.strictEqual(warned.length, 1);
    assert.strictEqual(warned[0].level, 'warn');
    assert.strictEqual(warned[0].name, 'io.github.example/ws');
  });

  it('a local+upstream record that upstream no longer confirms goes back to origin local without mirroredAt', async () => {
    await publish(server('io.github.example/ws', '1.0.0'));
    await publish(server('io.github.example/vs', '1.0.0'));
    tick();
    await sync([rec('io.github.example/ws', '1.0.0'), rec('io.github.example/vs', '1.0.0')]);
    assert.deepStrictEqual((await rows('io.github.example/ws')).map((r) => r.origin), ['local+upstream']);
    tick();
    // ws diverges upstream: a conflict, no longer confirmed.
    await sync([rec('io.github.example/ws', '1.0.0', {server: {description: 'changed upstream'}, updatedAt: '2026-11-10T12:00:00Z'}), rec('io.github.example/vs', '1.0.0')]);
    const [ws] = await rows('io.github.example/ws');
    assert.deepStrictEqual([ws.origin, ws.mirrored_at], ['local', null]);
    // vs's copies go away with their upstream.
    tick();
    await applyUpstreams(store, [], now().toISOString());
    const [vs] = await rows('io.github.example/vs');
    assert.deepStrictEqual([vs.origin, vs.mirrored_at], ['local', null]);
  });

  it('a conflict found when publishing over a mirrored version is logged once', async () => {
    await sync([rec('io.github.example/ws', '1.0.0', {server: {description: 'upstream wrote this'}})]);
    tick();
    await publishServer(store, server('io.github.example/ws', '1.0.0'), publisher([NS]), {claims: [NS], now: now(), log});
    tick();
    await sync([rec('io.github.example/ws', '1.0.0', {server: {description: 'upstream wrote this'}})]);
    assert.strictEqual(lines.filter((l) => l.event === 'publish.conflict').length, 1);
    assert.strictEqual((await store.read('SELECT COUNT(*) AS n FROM conflicts'))[0].n, 1);
  });

  it('an empty _meta and no _meta are the same document', async () => {
    await publish(server('io.github.example/ws', '1.0.0', {_meta: {}}));
    tick();
    await sync([rec('io.github.example/ws', '1.0.0')]);
    assert.deepStrictEqual((await rows('io.github.example/ws')).map((r) => r.origin), ['local+upstream']);
    assert.strictEqual((await store.read('SELECT COUNT(*) AS n FROM conflicts'))[0].n, 0);
  });

  it('upstream deprecated overlays the status of a local+upstream record', async () => {
    await publish(server('io.github.example/ws', '1.0.0'));
    tick();
    await sync([rec('io.github.example/ws', '1.0.0')]);
    tick();
    await sync([rec('io.github.example/ws', '1.0.0', {status: 'deprecated', statusMessage: 'moved', statusChangedAt: '2026-11-10T12:00:00Z', updatedAt: '2026-11-10T12:00:00Z'})]);
    const [r] = await rows('io.github.example/ws');
    assert.strictEqual(r.origin, 'local+upstream');
    assert.strictEqual(r.official.status, 'deprecated');
    assert.strictEqual(r.official.statusMessage, 'moved');
    assert.strictEqual(r.official.statusChangedAt, '2026-11-10T12:00:00Z');
    // A status change older than ours does not overlay it.
    await publish(server('io.github.example/vs', '1.0.0'));
    tick();
    await sync([rec('io.github.example/vs', '1.0.0', {status: 'deprecated', statusChangedAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z'})]);
    assert.strictEqual((await rows('io.github.example/vs'))[0].official.status, 'active');
  });

  it('upstream versions in a claimed namespace not present locally are mirrored', async () => {
    await publish(server('io.github.example/ws', '1.0.0'));
    await sync([rec('io.github.example/ws', '0.9.0', {isLatest: false}), rec('io.github.example/other', '1.0.0')]);
    assert.deepStrictEqual((await rows('io.github.example/ws')).map((r) => [r.version, r.source, r.origin]), [['0.9.0', 'mirror', 'mirror'], ['1.0.0', 'local', 'local']]);
    assert.deepStrictEqual((await rows('io.github.example/other')).map((r) => r.origin), ['mirror']);
  });

  it('isLatest over the union of local and mirrored versions, deleted skipped', async () => {
    await publish(server('io.github.example/ws', '1.2.0'));
    tick();
    await sync([rec('io.github.example/ws', '1.3.0')]);
    assert.deepStrictEqual(await latest('io.github.example/ws'), ['1.3.0']);
    tick();
    await sync([rec('io.github.example/ws', '1.3.0', {status: 'deleted', statusChangedAt: '2026-11-10T12:00:00Z', updatedAt: '2026-11-10T12:00:00Z'})]);
    assert.deepStrictEqual(await latest('io.github.example/ws'), ['1.2.0']);
  });

  it('publishing a version the mirror already has turns it local, compared with the copy', async () => {
    await sync([rec('io.github.example/ws', '1.0.0')]);
    tick();
    await publish(server('io.github.example/ws', '1.0.0'));
    const [r] = await rows('io.github.example/ws');
    assert.deepStrictEqual([r.source, r.origin], ['local', 'local+upstream']);
    // A later mirror pass leaves it local.
    tick();
    await sync([rec('io.github.example/ws', '1.0.0')]);
    assert.deepStrictEqual((await rows('io.github.example/ws')).map((x) => [x.source, x.origin]), [['local', 'local+upstream']]);
  });

  it('an added claim recomputes isLatest at startup', async () => {
    // Upstream marks the older, non-semver version latest; 7.4's rule picks the semver one.
    const name = 'io.github.later/ws';
    await sync([rec(name, '2.0.0', {isLatest: false, publishedAt: '2026-11-01T00:00:00Z'}), rec(name, 'nightly', {isLatest: true, publishedAt: '2026-11-02T00:00:00Z'})]);
    assert.deepStrictEqual(await latest(name), ['nightly']);
    tick();
    await applyClaims(store, [NS, 'io.github.later/'], now().toISOString());
    assert.deepStrictEqual(await latest(name), ['2.0.0']);
    // And the mirror keeps 7.4's rule for it afterwards.
    tick();
    await sync([rec(name, '2.0.0', {isLatest: false, publishedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z'}), rec(name, 'nightly', {isLatest: true, publishedAt: '2026-11-02T00:00:00Z'})]);
    assert.deepStrictEqual(await latest(name), ['2.0.0']);
  });

  it('a removed claim gives its mirrored names back the upstream rule', async () => {
    const name = 'io.github.later/ws';
    await applyClaims(store, [NS, 'io.github.later/'], now().toISOString());
    await sync([rec(name, '2.0.0', {isLatest: false, publishedAt: '2026-11-01T00:00:00Z'}), rec(name, 'nightly', {isLatest: true, publishedAt: '2026-11-02T00:00:00Z'})]);
    assert.deepStrictEqual(await latest(name), ['2.0.0']);
    tick();
    await applyClaims(store, [NS], now().toISOString());
    assert.deepStrictEqual(await latest(name), ['nightly']);
  });

  it('a removed claim with local records refuses startup listing the names (spec 13.3)', async () => {
    await publish(server('io.github.example/ws', '1.0.0'));
    await publish(server('io.github.example/zs', '1.0.0'));
    await assert.rejects(applyClaims(store, [], now().toISOString()), (err) => {
      assert.ok(err instanceof ClaimError);
      assert.deepStrictEqual(err.names, ['io.github.example/ws', 'io.github.example/zs']);
      assert.ok(err.message.includes('io.github.example/ws'), err.message);
      return true;
    });
    // A removed claim with no local records is fine.
    await applyClaims(store, [NS, 'io.github.empty/'], now().toISOString());
    await applyClaims(store, [NS], now().toISOString());
  });
});
