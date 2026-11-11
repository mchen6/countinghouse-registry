'use strict';
// The instance endpoints (spec section 9.4): the enabled list by change sequence,
// and results with their history.
const assert = require('assert');
const {startEnableApp, X, TOOLS} = require('./support/enable-app');
const {sha256Canonical} = require('countinghouse-registry-cli/lib/canonical-json');

describe('instance endpoints', () => {
  let t;
  let gw;
  beforeEach(async () => { t = await startEnableApp(); gw = await t.instance('gw-1'); });
  afterEach(async () => { await t.close(); });

  const enable = async (name, version = '1.0.0', inst = 'gw-1') => {
    const res = await t.call('PUT', t.enablePath(inst, name, version), await t.operator(), {});
    assert.strictEqual(res.status, 200, res.text);
  };
  const poll = async (since, {token = gw, inst = 'gw-1', limit} = {}) => {
    const q = [since === undefined ? null : `since=${since}`, limit === undefined ? null : `limit=${limit}`].filter(Boolean).join('&');
    return t.call('GET', `${X}/instances/${inst}/enabled${q ? `?${q}` : ''}`, token);
  };
  const post = (body, token = gw, inst = 'gw-1') => t.call('POST', `${X}/instances/${inst}/results`, token, body);
  const result = (name, outcome, extra = {}) => ({name, version: '1.0.0', outcome, ...extra});
  const stateOf = async (name) => (await t.store.read("SELECT state FROM enables WHERE instance = 'gw-1' AND name = ?", [name]))[0].state;

  it('returns only this instance\'s entries; another instance\'s token is 403', async () => {
    await t.seed('io.example/a', '1.0.0');
    await t.seed('io.example/b', '1.0.0');
    await enable('io.example/a');
    await enable('io.example/b', '1.0.0', 'gw-2');
    const res = await poll();
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.items.map((i) => i.name), ['io.example/a']);
    assert.deepStrictEqual(Object.keys(res.body.items[0]).sort(), ['name', 'notices', 'remote', 'state', 'status', 'updatedAt', 'version']);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined, 'instance routes send no CORS headers');
    assert.strictEqual((await poll(undefined, {inst: 'gw-2'})).status, 403);
    assert.strictEqual((await post(result('io.example/b', 'failed', {reason: 'timeout'}), gw, 'gw-2')).status, 403);
    assert.strictEqual((await poll(undefined, {token: null})).status, 401);
  });

  it('nextSince is the highest sequence returned; a poll with it returns only later changes', async () => {
    for (const n of ['a', 'b', 'c']) await t.seed(`io.example/${n}`, '1.0.0');
    await enable('io.example/a');
    await enable('io.example/b');
    const first = (await poll()).body;
    assert.deepStrictEqual(first.items.map((i) => i.name), ['io.example/a', 'io.example/b']);
    assert.match(first.nextSince, /^[0-9]+$/);
    const empty = (await poll(first.nextSince)).body;
    assert.deepStrictEqual(empty, {items: [], nextSince: first.nextSince});
    await enable('io.example/c');
    const later = (await poll(first.nextSince)).body;
    assert.deepStrictEqual(later.items.map((i) => i.name), ['io.example/c']);
    // A full page means "poll again now": the sequence is the cursor.
    const page = (await poll('0', {limit: 1})).body;
    assert.deepStrictEqual(page.items.map((i) => i.name), ['io.example/a']);
    assert.deepStrictEqual((await poll(page.nextSince, {limit: 2})).body.items.map((i) => i.name), ['io.example/b', 'io.example/c']);
    for (const bad of ['since=-1', 'since=1.5', 'since=abc', 'limit=0', 'limit=101', 'limit=x']) {
      assert.strictEqual((await t.call('GET', `${X}/instances/gw-1/enabled?${bad}`, gw)).status, 422, bad);
    }
  });

  it('a write committed after a poll\'s snapshot is returned by the next poll', async () => {
    await t.seed('io.example/a', '1.0.0');
    await t.seed('io.example/b', '1.0.0');
    await enable('io.example/a');
    const before = (await poll()).body;
    // A write that takes its sequence value and then waits before committing.
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = t.store.write(async (tx) => {
      const seq = await tx.nextSeq();
      await tx.run(`INSERT INTO enables (instance, name, version, state, remote_index, seq, updated_at, by_key)
        VALUES ('gw-1', 'io.example/b', '1.0.0', 'requested', 0, ?, '2026-11-10T12:00:00.000Z', 'ed25519:x')`, [seq]);
      await gate;
    });
    const during = (await poll(before.nextSince)).body;
    assert.deepStrictEqual(during.items, [], 'the uncommitted write is not seen');
    release();
    await slow;
    const after = (await poll(during.nextSince)).body;
    assert.deepStrictEqual(after.items.map((i) => i.name), ['io.example/b']);
  });

  it('validated requires tools in state requested; returns the registry\'s sha256', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    assert.strictEqual((await post(result('io.example/a', 'validated'))).status, 422, 'tools are required');
    const res = await post(result('io.example/a', 'validated', {tools: TOOLS}));
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, {sha256: sha256Canonical({tools: TOOLS})});
    assert.strictEqual(await stateOf('io.example/a'), 'validated');
    const item = (await poll()).body.items[0];
    assert.strictEqual(item.sha256, res.body.sha256);
    // Not in requested any more: a different validated result is refused.
    const other = await post(result('io.example/a', 'validated', {tools: [{name: 'other', inputSchema: {type: 'object'}}]}));
    assert.strictEqual(other.status, 409);
  });

  it('changed is accepted in validated with previousSha256, idempotent in changed, sets the tools-changed notice and leaves hosting', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    const {sha256} = (await post(result('io.example/a', 'validated', {tools: TOOLS}))).body;
    const hosting = async () => (await t.call('GET', `/v0.1/servers/${t.enc('io.example/a')}/versions/1.0.0`)).body._meta['io.github.mchen6/countinghouse-registry'].hosting;
    assert.deepStrictEqual(await hosting(), {hosted: true, instances: 1});
    const newTools = [...TOOLS, {name: 'added', inputSchema: {type: 'object'}}];
    assert.strictEqual((await post(result('io.example/a', 'changed', {tools: newTools}))).status, 422, 'previousSha256 is required');
    assert.strictEqual((await post(result('io.example/a', 'changed', {tools: newTools, previousSha256: 'f'.repeat(64)}))).status, 409, 'not the validated hash');
    const changed = await post(result('io.example/a', 'changed', {tools: newTools, previousSha256: sha256}));
    assert.strictEqual(changed.status, 200, changed.text);
    assert.deepStrictEqual(changed.body, {sha256: sha256Canonical({tools: newTools})});
    assert.strictEqual(await stateOf('io.example/a'), 'changed');
    const item = (await poll()).body.items[0];
    assert.deepStrictEqual(item.notices, ['tools-changed']);
    assert.strictEqual(await hosting(), undefined, 'a changed entry is not hosted');
    const repeat = await post(result('io.example/a', 'changed', {tools: newTools, previousSha256: sha256}));
    assert.strictEqual(repeat.status, 200);
    assert.strictEqual((await t.store.read('SELECT COUNT(*) AS n FROM results'))[0].n, 2, 'the repeat changed nothing');
    // A newer list while changed, against the current changed hash, is recorded,
    // so the operator approves the latest; against any other hash it is 409.
    const newer = [...newTools, {name: 'again', inputSchema: {type: 'object'}}];
    assert.strictEqual((await post(result('io.example/a', 'changed', {tools: newer, previousSha256: sha256}))).status, 409);
    const third = await post(result('io.example/a', 'changed', {tools: newer, previousSha256: changed.body.sha256}));
    assert.strictEqual(third.status, 200, third.text);
    assert.strictEqual((await poll()).body.items[0].sha256, sha256Canonical({tools: newer}));
  });

  it('failed requires a reason from the list and no tools; a validated entry that fails leaves hosting', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    await post(result('io.example/a', 'validated', {tools: TOOLS}));
    assert.strictEqual((await post(result('io.example/a', 'failed'))).status, 422);
    assert.strictEqual((await post(result('io.example/a', 'failed', {reason: 'boom'}))).status, 422);
    assert.strictEqual((await post(result('io.example/a', 'failed', {reason: 'timeout', tools: TOOLS}))).status, 422);
    for (const reason of ['unreachable', 'auth-rejected', 'protocol-error', 'invalid-tools-list', 'timeout', 'other']) {
      const res = await post(result('io.example/a', 'failed', {reason}));
      assert.strictEqual(res.status, 200, reason);
      assert.deepStrictEqual(res.body, {});
    }
    assert.strictEqual(await stateOf('io.example/a'), 'failed');
    const pub = (await t.call('GET', `/v0.1/servers/${t.enc('io.example/a')}/versions/1.0.0`)).body;
    assert.strictEqual(pub._meta['io.github.mchen6/countinghouse-registry'].hosting, undefined);
  });

  it('a repeat equal to the current result is 200 and changes nothing', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    await post(result('io.example/a', 'validated', {tools: TOOLS}));
    const seq = (await t.store.read('SELECT seq FROM enables'))[0].seq;
    // Same tools in another key order: the same canonical hash.
    const reordered = TOOLS.map((tool) => Object.fromEntries(Object.entries(tool).reverse()));
    const res = await post(result('io.example/a', 'validated', {tools: reordered}));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await t.store.read('SELECT seq FROM enables'))[0].seq, seq);
    assert.strictEqual((await t.store.read('SELECT COUNT(*) AS n FROM results'))[0].n, 1);
    await post(result('io.example/a', 'failed', {reason: 'timeout'}));
    await post(result('io.example/a', 'failed', {reason: 'timeout'}));
    assert.strictEqual((await t.store.read('SELECT COUNT(*) AS n FROM results'))[0].n, 2);
  });

  it('keeps every result as history', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    await post(result('io.example/a', 'failed', {reason: 'unreachable'}));
    await enable('io.example/a');
    await post(result('io.example/a', 'validated', {tools: TOOLS}));
    await post(result('io.example/a', 'failed', {reason: 'timeout'}));
    const rows = await t.store.read('SELECT outcome, reason, sha256 FROM results ORDER BY id');
    assert.deepStrictEqual(rows.map((r) => [r.outcome, r.reason || r.sha256.slice(0, 6)]), [['failed', 'unreachable'], ['validated', sha256Canonical({tools: TOOLS}).slice(0, 6)], ['failed', 'timeout']]);
  });

  it('409 for a disabled entry', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    await t.call('DELETE', t.enablePath('gw-1', 'io.example/a', '1.0.0'), await t.operator());
    const res = await post(result('io.example/a', 'failed', {reason: 'timeout'}));
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await post(result('io.example/never', 'failed', {reason: 'timeout'}))).status, 409, 'not enabled for this instance');
  });

  it('the envelope is closed: an extra field like tenant or caller is 422', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    for (const extra of [{tenant: 't1'}, {caller: 'c'}, {usage: 3}, {address: '10.0.0.1'}]) {
      const res = await post(result('io.example/a', 'failed', {reason: 'timeout', ...extra}));
      assert.strictEqual(res.status, 422, JSON.stringify(extra));
      assert.strictEqual(res.body.detail, 'validation failed');
    }
    // Tool items need name and inputSchema and are otherwise open.
    assert.strictEqual((await post(result('io.example/a', 'validated', {tools: [{name: 'x'}]}))).status, 422);
    assert.strictEqual((await post(result('io.example/a', 'validated', {tools: [{name: 'x', inputSchema: {}, annotations: {readOnlyHint: true}, title: 'X'}]}))).status, 200);
  });

  it('413 over 1 MiB', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    const res = await post(result('io.example/a', 'validated', {tools: [{name: 'x', inputSchema: {}, description: 'x'.repeat(1024 * 1024)}]}));
    assert.strictEqual(res.status, 413);
  });

  it('413 over 500 tools', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    const tools = Array.from({length: 501}, (_, i) => ({name: `t${i}`, inputSchema: {}}));
    const res = await post(result('io.example/a', 'validated', {tools}));
    assert.strictEqual(res.status, 413);
    assert.strictEqual(res.body.detail, 'A result holds at most 500 tools');
  });

  it('a local publisher\'s status change reaches the instance, with no upstream notice', async () => {
    await t.seed('com.example/own', '1.0.0', {source: 'local', origin: 'local'});
    await enable('com.example/own');
    const start = (await poll()).body.nextSince;
    const res = await t.call('PATCH', `/v0.1/servers/${t.enc('com.example/own')}/versions/1.0.0/status`, await t.operator(), {status: 'deprecated', statusMessage: 'use 2.0.0'});
    assert.strictEqual(res.status, 200, res.text);
    const items = (await poll(start)).body.items;
    assert.deepStrictEqual(items.map((i) => [i.name, i.status, i.notices]), [['com.example/own', 'deprecated', []]]);
  });

  const officialOf = (status, at = '2026-11-01T00:00:00Z') => ({status, statusChangedAt: at, publishedAt: '2026-11-01T00:00:00Z', updatedAt: at, isLatest: true});
  const addCopy = (name, server, official) => t.store.write(async (tx) => {
    await tx.run("INSERT INTO mirror_upstreams (name, position, url) VALUES ('official', 0, 'https://registry.example') ON CONFLICT (name) DO NOTHING");
    await tx.run(`INSERT INTO record_sources (upstream, name, version, server, official, mirrored_at) VALUES ('official', ?, '1.0.0', ?, ?, '2026-11-10T00:00:00.000Z')
      ON CONFLICT (upstream, name, version) DO UPDATE SET server = excluded.server, official = excluded.official`, [name, JSON.stringify(server), JSON.stringify(official)]);
  });
  const rebuild = (names) => t.store.write((tx) => require('../lib/mirror/sources').rebuildNames(tx, names, '2026-11-10T06:00:00.000Z'));

  it('a local+upstream record carries an upstream notice only for upstream\'s status, and loses it with the last copy', async () => {
    const {remoteServer} = require('./support/enable-app');
    const name = 'com.example/both';
    await t.seed(name, '1.0.0', {source: 'local', origin: 'local+upstream'});
    await addCopy(name, remoteServer(name, '1.0.0'), officialOf('active'));
    await enable(name);
    // The publisher's own deprecation: no upstream notice.
    let mark = (await poll()).body.nextSince;
    await t.call('PATCH', `/v0.1/servers/${t.enc(name)}/versions/1.0.0/status`, await t.operator(), {status: 'deprecated'});
    let items = (await poll(mark)).body.items;
    assert.deepStrictEqual(items.map((i) => [i.status, i.notices]), [['deprecated', []]]);
    // Upstream deprecates it later: its status overlays ours, with the notice.
    await t.call('PATCH', `/v0.1/servers/${t.enc(name)}/versions/1.0.0/status`, await t.operator(), {status: 'active'});
    mark = (await poll()).body.nextSince;
    await addCopy(name, remoteServer(name, '1.0.0'), officialOf('deprecated', '2030-01-01T00:00:00Z'));
    await rebuild([name]);
    items = (await poll(mark)).body.items;
    assert.deepStrictEqual(items.map((i) => [i.status, i.notices]), [['deprecated', ['upstream-deprecated']]]);
    // The last copy goes: origin local, and the instance hears the notice go.
    mark = (await poll()).body.nextSince;
    await t.store.write((tx) => tx.run('DELETE FROM record_sources WHERE name = ?', [name]));
    await rebuild([name]);
    items = (await poll(mark)).body.items;
    assert.deepStrictEqual(items.map((i) => [i.status, i.notices]), [['deprecated', []]]);
  });

  it('a change to the served remotes reaches the instance', async () => {
    const {remoteServer, STREAMABLE} = require('./support/enable-app');
    const name = 'io.example/moved';
    await addCopy(name, remoteServer(name, '1.0.0'), officialOf('active'));
    await rebuild([name]);
    await enable(name);
    const mark = (await poll()).body.nextSince;
    await addCopy(name, remoteServer(name, '1.0.0', [STREAMABLE(7)]), officialOf('active'));
    await rebuild([name]);
    const items = (await poll(mark)).body.items;
    assert.deepStrictEqual(items.map((i) => i.remote.url), [STREAMABLE(7).url]);
  });

  it('a delayed retry of a result accepted earlier in the same enable is 200 and changes nothing', async () => {
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    const v = (await post(result('io.example/a', 'validated', {tools: TOOLS}))).body.sha256;
    const c1tools = [...TOOLS, {name: 'c1', inputSchema: {}}];
    const c1 = (await post(result('io.example/a', 'changed', {tools: c1tools, previousSha256: v}))).body.sha256;
    const c2tools = [...c1tools, {name: 'c2', inputSchema: {}}];
    assert.strictEqual((await post(result('io.example/a', 'changed', {tools: c2tools, previousSha256: c1}))).status, 200);
    const count = (await t.store.read('SELECT COUNT(*) AS n FROM results'))[0].n;
    // Retries of the first changed and of the validated, arriving late.
    assert.strictEqual((await post(result('io.example/a', 'changed', {tools: c1tools, previousSha256: v}))).status, 200);
    assert.strictEqual((await post(result('io.example/a', 'validated', {tools: TOOLS}))).status, 200);
    assert.strictEqual((await t.store.read('SELECT COUNT(*) AS n FROM results'))[0].n, count);
    assert.strictEqual(await stateOf('io.example/a'), 'changed');
    // After a re-PUT the same tools validate afresh, and the poll shows no hash
    // from the previous enable until then.
    await enable('io.example/a');
    const item = (await poll()).body.items.find((i) => i.name === 'io.example/a');
    assert.strictEqual(item.state, 'requested');
    assert.strictEqual(item.sha256, undefined);
    assert.strictEqual((await post(result('io.example/a', 'validated', {tools: TOOLS}))).status, 200);
    assert.strictEqual(await stateOf('io.example/a'), 'validated');
  });

  it('an instance removed from config is not counted, and its results are refused', async () => {
    const {applyInstances} = require('../lib/enable/enable');
    await t.seed('io.example/a', '1.0.0');
    await enable('io.example/a');
    await enable('io.example/a', '1.0.0', 'gw-2');
    const gw2 = await t.instance('gw-2');
    await post(result('io.example/a', 'validated', {tools: TOOLS}));
    await post(result('io.example/a', 'validated', {tools: TOOLS}), gw2, 'gw-2');
    const hosting = async () => (await t.call('GET', `/v0.1/servers/${t.enc('io.example/a')}/versions/1.0.0`)).body._meta['io.github.mchen6/countinghouse-registry'].hosting;
    assert.deepStrictEqual(await hosting(), {hosted: true, instances: 2});
    // At startup with gw-2 gone from config, its entries are disabled.
    const disabled = await applyInstances(t.store, ['gw-1'], '2026-11-10T13:00:00.000Z');
    assert.deepStrictEqual(disabled, ['gw-2']);
    assert.deepStrictEqual(await hosting(), {hosted: true, instances: 1});
    assert.deepStrictEqual(await applyInstances(t.store, ['gw-1'], '2026-11-10T13:00:00.000Z'), [], 'idempotent');
  });

  it('results from an instance not in config are 404, even with a live token', async () => {
    const gw2 = await t.instance('gw-2');
    await t.close();
    const {startEnableApp: start} = require('./support/enable-app');
    t = await start({config: {instances: [require('./support/enable-app').CONFIG.instances[0]]}});
    const res = await post(result('io.example/a', 'failed', {reason: 'timeout'}), gw2, 'gw-2');
    assert.strictEqual(res.status, 404);
  });

  it('upstream deprecated, deleted, gone-upstream and conflict appear as notices; keepDeleted silences upstream-deleted', async () => {
    const official = (status) => ({status, statusChangedAt: '2026-11-01T00:00:00Z', publishedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', isLatest: true});
    await t.seed('io.example/dep', '1.0.0');
    await t.seed('io.example/del', '1.0.0');
    await t.seed('io.example/gone', '1.0.0');
    await t.seed('com.example/own', '1.0.0', {source: 'local', origin: 'local'});
    for (const n of ['io.example/dep', 'io.example/del', 'io.example/gone', 'com.example/own']) await enable(n);
    const start = (await poll()).body.nextSince;
    // Upstream changes arrive through the mirror's rebuild, which moves the sequence.
    const {rebuildNames} = require('../lib/mirror/sources');
    await t.store.write(async (tx) => {
      await tx.run("INSERT INTO mirror_upstreams (name, position, url) VALUES ('official', 0, 'https://registry.example') ON CONFLICT (name) DO NOTHING");
      const copy = (name, status) => tx.run('INSERT INTO record_sources (upstream, name, version, server, official, mirrored_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['official', name, '1.0.0', JSON.stringify(require('./support/enable-app').remoteServer(name, '1.0.0')), JSON.stringify(official(status)), '2026-11-10T00:00:00.000Z']);
      await copy('io.example/dep', 'deprecated');
      await copy('io.example/del', 'deleted');
      await copy('com.example/own', 'active');
      // gone: no copy at all, so the rebuild hides it.
      await rebuildNames(tx, ['io.example/dep', 'io.example/del', 'io.example/gone'], '2026-11-10T00:00:00.000Z');
      await tx.run(`INSERT INTO conflicts (name, version, local_sha, upstream_sha, first_seen) VALUES ('com.example/own', '1.0.0', ?, ?, '2026-11-10T00:00:00.000Z')`, ['a'.repeat(64), 'b'.repeat(64)]);
      await require('../lib/publish/conflicts').touchEnables(tx, 'com.example/own', '1.0.0');
    });
    const notices = async (since) => Object.fromEntries((await poll(since)).body.items.map((i) => [i.name, i.notices]));
    assert.deepStrictEqual(await notices(start), {
      'io.example/dep': ['upstream-deprecated'], 'io.example/del': ['upstream-deleted'], 'io.example/gone': ['gone-upstream'], 'com.example/own': ['conflict']});
    const mark = (await poll()).body.nextSince;
    for (const n of ['io.example/del', 'io.example/gone']) {
      assert.strictEqual((await t.call('POST', `${X}/overrides/${t.enc(n)}/versions/1.0.0`, await t.operator(), {keepDeleted: true})).status, 200);
    }
    assert.deepStrictEqual(await notices(mark), {'io.example/del': [], 'io.example/gone': []});
    // The item still says what upstream says.
    assert.strictEqual((await poll()).body.items.find((i) => i.name === 'io.example/del').status, 'deleted');
  });
});
