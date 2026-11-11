'use strict';
// The operator endpoints (spec sections 7.2, 7.3, 6.8 and 9.3's operate
// permission): conflicts and their acknowledgement, the keepDeleted override,
// sync now, operator reads, and the audit trail. In process, with real tokens.
const assert = require('assert');
const {injectApp} = require('./support/inject');
const {edKeyPair} = require('./support/keys');
const {insertRecord, server} = require('./support/records');
const {createAuth} = require('../lib/auth/middleware');
const {applyClaims} = require('../lib/publish/namespaces');
const {compareWithLocal} = require('../lib/publish/conflicts');
const {hasOverride, openConflict} = require('../lib/operator/routes');
const {signTimestamp} = require('countinghouse-registry-cli/lib/sign');

const X = '/v0.1/x/io.github.mchen6/countinghouse-registry';
const OURS = 'io.github.mchen6/countinghouse-registry';
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const SECRET = Buffer.from('6f'.repeat(32), 'hex');
const T0 = Date.parse('2026-11-10T12:00:00Z');

const OPS = edKeyPair();
const PUB = edKeyPair();
const OPS_FP = `ed25519:${OPS.publicB64.slice(0, 8)}`;
const CONFIG = {
  claims: ['com.example/'],
  publisherKeys: [
    {name: 'ops', algorithm: 'ed25519', publicKey: OPS.publicB64, domains: ['ops.example.org'], namespaces: [], operate: true},
    {name: 'pub', algorithm: 'ed25519', publicKey: PUB.publicB64, domains: ['example.com'], namespaces: ['com.example/'], operate: false}
  ],
  upstreams: [
    {name: 'official', url: 'https://registry.example', intervalMinutes: 60, reconcile: {everyDays: 7, atHour: 3}},
    {name: 'mine', url: 'https://mine.example', intervalMinutes: 60, reconcile: {everyDays: 7, atHour: 3}},
    {name: 'third', url: 'https://third.example', intervalMinutes: 60, reconcile: {everyDays: 7, atHour: 3}}
  ]
};

// A stand-in for createMirror: runNow(name?) starts a run unless one is going.
function fakeMirror() {
  const m = {running: new Set(), calls: []};
  m.runNow = (name) => {
    m.calls.push(name);
    const names = name === undefined ? CONFIG.upstreams.map((u) => u.name) : [name];
    const idle = names.filter((n) => !m.running.has(n));
    for (const n of idle) m.running.add(n);
    return {started: idle.length > 0};
  };
  return m;
}

describe('operator endpoints', () => {
  let t;
  let clock;
  let mirror;
  const start = async () => {
    mirror = fakeMirror();
    t = await injectApp({config: CONFIG, makeDeps: ({config, log}) => {
      const now = () => new Date(clock);
      return {now, mirror, auth: createAuth({config, secret: SECRET, log, now})};
    }});
    await applyClaims(t.store, CONFIG.claims, new Date(clock).toISOString());
    await t.store.write(async (tx) => {
      for (const [i, u] of CONFIG.upstreams.entries()) {
        await tx.run('INSERT INTO mirror_upstreams (name, position, url) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET position = excluded.position', [u.name, i, u.url]);
      }
    });
  };
  beforeEach(async () => { clock = T0; await start(); });
  afterEach(async () => { if (t) await t.close(); t = null; });

  const tokens = [];
  const login = async (kp, domain) => {
    clock += 1000;
    const res = await t.request({method: 'POST', path: '/v0/auth/dns', body: {domain, ...signTimestamp(kp.privateHex, 'ed25519', new Date(clock))}});
    assert.strictEqual(res.status, 200, res.text);
    tokens.push(res.body.registry_token);
    return res.body.registry_token;
  };
  const operator = () => login(OPS, 'ops.example.org');
  const publisherToken = () => login(PUB, 'example.com');
  const call = (method, path, token, body) => t.request({method, path, body, headers: token ? {authorization: `Bearer ${token}`} : {}});

  const addConflict = (name, version) => t.store.write((tx) => tx.run(
    'INSERT INTO conflicts (name, version, local_sha, upstream_sha, first_seen) VALUES (?, ?, ?, ?, ?)',
    [name, version, 'a'.repeat(64), 'b'.repeat(64), '2026-11-09T00:00:00.000Z']));
  const auditRows = () => t.store.read('SELECT key_fp, action, subject, at FROM audit ORDER BY id');

  it('lists conflicts to operators only', async () => {
    await insertRecord(t.store, {source: 'local', origin: 'local', name: 'com.example/srv', version: '1.0.0'});
    await addConflict('com.example/srv', '1.0.0');
    assert.strictEqual((await call('GET', `${X}/conflicts`)).status, 401);
    const pub = await call('GET', `${X}/conflicts`, await publisherToken());
    assert.strictEqual(pub.status, 403);
    assert.strictEqual(pub.headers['access-control-allow-origin'], undefined, 'operator routes send no CORS headers');
    const res = await call('GET', `${X}/conflicts`, await operator());
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, {conflicts: [{name: 'com.example/srv', version: '1.0.0', localSha256: 'a'.repeat(64), upstreamSha256: 'b'.repeat(64),
      firstSeen: '2026-11-09T00:00:00.000Z', acknowledgedBy: null, acknowledgedAt: null}]});
    // Also under /v0.
    assert.strictEqual((await call('GET', '/v0/x/io.github.mchen6/countinghouse-registry/conflicts', await operator())).status, 200);
  });

  it('acknowledge records who and when, and is idempotent', async () => {
    await insertRecord(t.store, {source: 'local', origin: 'local', name: 'com.example/srv', version: '1.0.0'});
    await addConflict('com.example/srv', '1.0.0');
    await t.store.write((tx) => tx.run(`INSERT INTO enables (instance, name, version, state, remote_index, seq, updated_at, by_key)
      VALUES ('gw-1', 'com.example/srv', '1.0.0', 'validated', 0, 0, '2026-11-09T00:00:00.000Z', 'ed25519:x')`));
    assert.strictEqual(await t.store.write((tx) => openConflict(tx, 'com.example/srv', '1.0.0')), true);
    const token = await operator();
    const path = `${X}/conflicts/${encodeURIComponent('com.example/srv')}/versions/1.0.0/acknowledge`;
    const first = await call('POST', path, token);
    assert.strictEqual(first.status, 200, first.text);
    const at = new Date(clock).toISOString();
    assert.deepStrictEqual([first.body.acknowledgedBy, first.body.acknowledgedAt], [OPS_FP, at]);
    clock += 60000;
    const again = await call('POST', path, token);
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual([again.body.acknowledgedBy, again.body.acknowledgedAt], [OPS_FP, at], 'the first acknowledgement stands');
    assert.strictEqual(await t.store.write((tx) => openConflict(tx, 'com.example/srv', '1.0.0')), false);
    assert.deepStrictEqual((await auditRows()).map((r) => [r.action, r.subject]), [['conflict.acknowledge', 'com.example/srv@1.0.0']]);
    // The instance's entry took a change sequence value, so its next poll sees it.
    const [e] = await t.store.read('SELECT seq FROM enables');
    assert.ok(e.seq > 0);
    assert.strictEqual((await call('POST', `${X}/conflicts/${encodeURIComponent('com.example/none')}/versions/1.0.0/acknowledge`, token)).status, 404);
    assert.strictEqual((await call('POST', path, await publisherToken())).status, 403);
  });

  it('an identical upstream copy closes a recorded conflict', async () => {
    const doc = server('com.example/srv', '1.0.0');
    await insertRecord(t.store, {source: 'local', origin: 'local', name: 'com.example/srv', version: '1.0.0', server: doc});
    await addConflict('com.example/srv', '1.0.0');
    await t.store.write((tx) => tx.run(`INSERT INTO enables (instance, name, version, state, remote_index, seq, updated_at, by_key)
      VALUES ('gw-1', 'com.example/srv', '1.0.0', 'validated', 0, 0, '2026-11-09T00:00:00.000Z', 'ed25519:x')`));
    const official = JSON.stringify({status: 'active', statusChangedAt: '2026-11-01T00:00:00Z', publishedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', isLatest: true});
    const outcome = await t.store.write((tx) => compareWithLocal(tx, {name: 'com.example/srv', version: '1.0.0', server: JSON.stringify(doc), official, mirrored_at: '2026-11-10T00:00:00.000Z'}, {nowIso: '2026-11-10T00:00:00.000Z'}));
    assert.strictEqual(outcome, 'identical');
    assert.strictEqual((await t.store.read('SELECT * FROM conflicts')).length, 0);
    // The instance serving it learns on its next poll (the notice goes away).
    const [e] = await t.store.read('SELECT seq FROM enables');
    assert.ok(e.seq > 0, 'the entry took a change sequence value');
    // Comparing again changes nothing more.
    await t.store.write((tx) => compareWithLocal(tx, {name: 'com.example/srv', version: '1.0.0', server: JSON.stringify(doc), official, mirrored_at: '2026-11-10T00:00:00.000Z'}, {nowIso: '2026-11-10T00:00:00.000Z'}));
    assert.strictEqual((await t.store.read('SELECT seq FROM enables'))[0].seq, e.seq);
  });

  it('reads vary on Authorization, and an operator read is never stored by a shared cache', async () => {
    await insertRecord(t.store, {name: 'io.example/one', version: '1.0.0'});
    const pub = await call('GET', '/v0.1/servers');
    assert.match(pub.headers.vary || '', /Authorization/);
    const op = await call('GET', '/v0.1/servers', await operator());
    assert.match(op.headers.vary || '', /Authorization/);
    assert.strictEqual(op.headers['cache-control'], 'private, no-store');
  });

  it('a keepDeleted override is only for a version deleted upstream or gone from it', async () => {
    await insertRecord(t.store, {name: 'io.example/live', version: '1.0.0'});
    const res = await call('POST', `${X}/overrides/${encodeURIComponent('io.example/live')}/versions/1.0.0`, await operator(), {keepDeleted: true});
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.detail, 'io.example/live@1.0.0 is not deleted upstream or gone from it; keepDeleted applies only to such versions');
    assert.deepStrictEqual(await auditRows(), []);
  });

  it('checks the operate permission before reading a body', async () => {
    for (const path of [`${X}/mirror/sync`, `${X}/overrides/${encodeURIComponent('io.example/x')}/versions/1.0.0`]) {
      const res = await call('POST', path, null, '{bad');
      assert.strictEqual(res.status, 401, path);
    }
  });

  it('keepDeleted never changes public responses', async () => {
    const name = 'io.example/removed';
    await insertRecord(t.store, {name, version: '1.0.0', official: {status: 'deleted', statusChangedAt: '2026-11-02T00:00:00Z', publishedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', isLatest: false}});
    await insertRecord(t.store, {name, version: '2.0.0', hidden_reason: 'gone-upstream'});
    const reads = [`/v0.1/servers/${encodeURIComponent(name)}/versions/1.0.0`, `/v0.1/servers/${encodeURIComponent(name)}/versions/2.0.0`,
      '/v0.1/servers', '/v0.1/servers?include_deleted=true', `/v0.1/servers?updated_since=${encodeURIComponent('2026-11-01T00:00:00Z')}`];
    const publicView = async () => Promise.all(reads.map(async (p) => {
      const r = await call('GET', p);
      return [r.status, r.text];
    }));
    const before = await publicView();
    assert.strictEqual(before[0][0], 404);
    const token = await operator();
    for (const v of ['1.0.0', '2.0.0']) {
      const res = await call('POST', `${X}/overrides/${encodeURIComponent(name)}/versions/${v}`, token, {keepDeleted: true});
      assert.strictEqual(res.status, 200, res.text);
      assert.deepStrictEqual(res.body, {name, version: v, keepDeleted: true, by: OPS_FP, at: new Date(clock).toISOString()});
    }
    assert.deepStrictEqual(await publicView(), before);
    assert.strictEqual(await t.store.write((tx) => hasOverride(tx, name, '1.0.0')), true);
    const del = await call('DELETE', `${X}/overrides/${encodeURIComponent(name)}/versions/1.0.0`, token);
    assert.strictEqual(del.status, 204);
    assert.strictEqual(await t.store.write((tx) => hasOverride(tx, name, '1.0.0')), false);
    assert.strictEqual(await t.store.write((tx) => hasOverride(tx, name, '2.0.0')), true);
    assert.deepStrictEqual(await publicView(), before);
    assert.strictEqual((await call('DELETE', `${X}/overrides/${encodeURIComponent(name)}/versions/1.0.0`, token)).status, 404);
    // The body is exactly {keepDeleted: true}; the version must exist.
    for (const body of [{}, {keepDeleted: false}, {keepDeleted: true, extra: 1}, [true]]) {
      assert.strictEqual((await call('POST', `${X}/overrides/${encodeURIComponent(name)}/versions/1.0.0`, token, body)).status, 422, JSON.stringify(body));
    }
    assert.strictEqual((await call('POST', `${X}/overrides/${encodeURIComponent(name)}/versions/9.9.9`, token, {keepDeleted: true})).status, 404);
  });

  it('conflict: true appears on operator reads and never on public ones', async () => {
    await insertRecord(t.store, {source: 'local', origin: 'local', name: 'com.example/srv', version: '1.0.0'});
    await addConflict('com.example/srv', '1.0.0');
    const path = `/v0.1/servers/${encodeURIComponent('com.example/srv')}/versions/1.0.0`;
    const ours = async (token) => (await call('GET', path, token)).body._meta[OURS];
    assert.strictEqual((await ours()).conflict, undefined);
    assert.strictEqual((await ours(await publisherToken())).conflict, undefined, 'a publisher token is not an operator');
    assert.strictEqual((await ours('not-a-token')).conflict, undefined, 'a bad token on a read is a public read');
    assert.strictEqual((await ours(await operator())).conflict, true);
    const list = await call('GET', '/v0.1/servers', await operator());
    assert.strictEqual(list.body.servers[0]._meta[OURS].conflict, true);
    // Acknowledged, the conflict is still there.
    await call('POST', `${X}/conflicts/${encodeURIComponent('com.example/srv')}/versions/1.0.0/acknowledge`, await operator());
    assert.strictEqual((await ours(await operator())).conflict, true);
  });

  it('operator reads name the serving upstream and the others that agree or differ; public reads never do', async () => {
    const name = 'io.example/both';
    const doc = server(name, '1.0.0');
    const official = JSON.stringify({status: 'active', statusChangedAt: '2026-11-01T00:00:00Z', publishedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', isLatest: true});
    await insertRecord(t.store, {name, version: '1.0.0', server: doc});
    await t.store.write(async (tx) => {
      await tx.run("UPDATE records SET upstream = 'official' WHERE name = ?", [name]);
      const copy = (u, s) => tx.run('INSERT INTO record_sources (upstream, name, version, server, official, mirrored_at) VALUES (?, ?, ?, ?, ?, ?)',
        [u, name, '1.0.0', JSON.stringify(s), official, '2026-11-10T00:00:00.000Z']);
      await copy('official', doc);
      // An identical copy apart from _meta outside publisher-provided, and a different one.
      await copy('mine', {...doc, _meta: {'com.example/other': {x: 1}}});
      await copy('third', {...doc, description: 'changed'});
    });
    const path = `/v0.1/servers/${encodeURIComponent(name)}/versions/1.0.0`;
    const op = (await call('GET', path, await operator())).body._meta[OURS];
    assert.strictEqual(op.upstream, 'official');
    assert.deepStrictEqual(op.alsoAt, ['mine']);
    assert.deepStrictEqual(op.differsAt, ['third']);
    const pub = (await call('GET', path)).body;
    assert.deepStrictEqual(Object.keys(pub._meta[OURS]).sort(), ['changedAt', 'mirroredAt', 'origin']);
    assert.strictEqual(pub._meta[OFFICIAL].status, 'active');
  });

  it('sync now returns 202, then 409 while running', async () => {
    const token = await operator();
    const first = await call('POST', `${X}/mirror/sync`, token);
    assert.strictEqual(first.status, 202, first.text);
    assert.deepStrictEqual(first.body, {started: true});
    const second = await call('POST', `${X}/mirror/sync`, token);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.detail, 'A mirror run is already in progress');
    mirror.running.clear();
    assert.strictEqual((await call('POST', `${X}/mirror/sync`, token, {upstream: 'mine'})).status, 202);
    assert.deepStrictEqual(mirror.calls, [undefined, undefined, 'mine']);
    const unknown = await call('POST', `${X}/mirror/sync`, token, {upstream: 'nope'});
    assert.strictEqual(unknown.body.detail, 'No upstream named nope is configured');
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual((await call('POST', `${X}/mirror/sync`, token, {upstream: 7})).status, 422);
    assert.strictEqual((await call('POST', `${X}/mirror/sync`, await publisherToken())).status, 403);
    assert.strictEqual((await call('POST', `${X}/mirror/sync`)).status, 401);
  });

  it('sync now with no upstreams configured is 404, not 409', async () => {
    await t.close();
    mirror = fakeMirror();
    t = await injectApp({config: {...CONFIG, upstreams: []}, makeDeps: ({config, log}) => {
      const now = () => new Date(clock);
      return {now, mirror: {runNow: () => ({started: false})}, auth: createAuth({config, secret: SECRET, log, now})};
    }});
    const res = await call('POST', `${X}/mirror/sync`, await operator());
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.detail, 'No upstreams are configured');
  });

  it('the named per-upstream mirror state is for operators only', async () => {
    assert.strictEqual((await call('GET', `${X}/mirror/upstreams`)).status, 401);
    const res = await call('GET', `${X}/mirror/upstreams`, await operator());
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.upstreams.map((u) => u.name), ['official', 'mine', 'third']);
    const pub = await call('GET', `${X}/mirror`);
    assert.strictEqual(pub.body.upstreams, 3, 'the public view keeps the count');
  });

  it('every operator action writes an audit row with the key fingerprint and no token', async () => {
    await insertRecord(t.store, {source: 'local', origin: 'local', name: 'com.example/srv', version: '1.0.0', hidden_reason: 'gone-upstream'});
    await addConflict('com.example/srv', '1.0.0');
    const token = await operator();
    await call('POST', `${X}/conflicts/${encodeURIComponent('com.example/srv')}/versions/1.0.0/acknowledge`, token);
    await call('POST', `${X}/overrides/${encodeURIComponent('com.example/srv')}/versions/1.0.0`, token, {keepDeleted: true});
    await call('DELETE', `${X}/overrides/${encodeURIComponent('com.example/srv')}/versions/1.0.0`, token);
    await call('POST', `${X}/mirror/sync`, token, {upstream: 'mine'});
    const rows = await auditRows();
    assert.deepStrictEqual(rows.map((r) => [r.key_fp, r.action, r.subject]), [
      [OPS_FP, 'conflict.acknowledge', 'com.example/srv@1.0.0'],
      [OPS_FP, 'override.set', 'com.example/srv@1.0.0'],
      [OPS_FP, 'override.remove', 'com.example/srv@1.0.0'],
      [OPS_FP, 'mirror.sync', 'mine']
    ]);
    const dump = JSON.stringify(await t.store.read('SELECT * FROM audit')) + t.logLines.join('');
    for (const tok of tokens) {
      for (const part of [tok, ...tok.split('.')]) assert.ok(!dump.includes(part), 'no token in audit rows or logs');
    }
    const logged = t.logLines.map((l) => JSON.parse(l)).filter((l) => l.event === 'operator.action');
    assert.deepStrictEqual(logged.map((l) => [l.action, l.fingerprint]), rows.map((r) => [r.action, OPS_FP]));
  });
});
