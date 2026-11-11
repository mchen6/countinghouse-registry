'use strict';
// Enabling a remote entry on a gateway instance (spec section 9.3), operator side.
const assert = require('assert');
const {startEnableApp, X, OPS_FP, STREAMABLE, SSE} = require('./support/enable-app');

describe('enables (operator)', () => {
  let t;
  beforeEach(async () => { t = await startEnableApp(); });
  afterEach(async () => { await t.close(); });

  const put = async (inst, name, version, body, token) => t.call('PUT', t.enablePath(inst, name, version), token || await t.operator(), body);
  const poll = async (inst, since) => {
    const res = await t.call('GET', `${X}/instances/${inst}/enabled${since === undefined ? '' : `?since=${since}`}`, await t.instance(inst));
    assert.strictEqual(res.status, 200, res.text);
    return res.body;
  };

  it('enables a visible record with a streamable-http remote; default remote is the first one', async () => {
    await t.seed('io.example/srv', '1.0.0', {remotes: [SSE, STREAMABLE(1), STREAMABLE(2)]});
    const res = await put('gw-1', 'io.example/srv', '1.0.0', {});
    assert.strictEqual(res.status, 200, res.text);
    const at = new Date(t.clock.now).toISOString();
    assert.deepStrictEqual(res.body, {instance: 'gw-1', name: 'io.example/srv', version: '1.0.0', state: 'requested', remote: STREAMABLE(1), updatedAt: at, by: OPS_FP});
    // A chosen remote by index; it must be streamable-http.
    assert.strictEqual((await put('gw-2', 'io.example/srv', '1.0.0', {remote: 2})).body.remote.url, STREAMABLE(2).url);
    assert.strictEqual((await put('gw-2', 'io.example/srv', '1.0.0', {remote: 0})).status, 422, 'sse is not enabled in version 1');
    assert.strictEqual((await put('gw-2', 'io.example/srv', '1.0.0', {remote: 3})).status, 422, 'no such remote');
    for (const body of [{remote: -1}, {remote: 1.5}, {remote: '1'}, {extra: true}, [1]]) {
      assert.strictEqual((await put('gw-2', 'io.example/srv', '1.0.0', body)).status, 422, JSON.stringify(body));
    }
    const {items} = await poll('gw-1');
    assert.deepStrictEqual(items.map((i) => [i.name, i.version, i.state, i.remote.url, i.status]), [['io.example/srv', '1.0.0', 'requested', STREAMABLE(1).url, 'active']]);
  });

  it('refuses an unknown instance, a missing version, and tokens without operate', async () => {
    await t.seed('io.example/srv', '1.0.0');
    assert.strictEqual((await put('gw-9', 'io.example/srv', '1.0.0', {})).status, 404);
    assert.strictEqual((await put('gw-1', 'io.example/srv', '9.9.9', {})).status, 404);
    assert.strictEqual((await put('gw-1', 'io.example/srv', '1.0.0', {}, await t.instance('gw-1'))).status, 403);
    assert.strictEqual((await t.call('PUT', t.enablePath('gw-1', 'io.example/srv', '1.0.0'), null, {})).status, 401);
  });

  it('422 when there is no streamable-http remote (sse only)', async () => {
    await t.seed('io.example/sse', '1.0.0', {remotes: [SSE]});
    const res = await put('gw-1', 'io.example/sse', '1.0.0', {});
    assert.strictEqual(res.status, 422);
    assert.match(res.body.detail, /no streamable-http remote/);
    await t.seed('io.example/none', '1.0.0', {remotes: []});
    assert.strictEqual((await put('gw-1', 'io.example/none', '1.0.0', {})).status, 422);
  });

  it('409 with an unacknowledged conflict; allowed after acknowledge', async () => {
    await t.seed('com.example/srv', '1.0.0', {source: 'local', origin: 'local'});
    await t.store.write((tx) => tx.run(`INSERT INTO conflicts (name, version, local_sha, upstream_sha, first_seen) VALUES ('com.example/srv', '1.0.0', ?, ?, '2026-11-09T00:00:00.000Z')`, ['a'.repeat(64), 'b'.repeat(64)]));
    const refused = await put('gw-1', 'com.example/srv', '1.0.0', {});
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.detail, /an unacknowledged conflict/);
    const token = await t.operator();
    assert.strictEqual((await t.call('POST', `${X}/conflicts/${t.enc('com.example/srv')}/versions/1.0.0/acknowledge`, token)).status, 200);
    assert.strictEqual((await put('gw-1', 'com.example/srv', '1.0.0', {})).status, 200);
  });

  it('409 for a deleted-upstream entry without the override; allowed with keepDeleted', async () => {
    const deleted = {status: 'deleted', statusChangedAt: '2026-11-02T00:00:00Z', publishedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', isLatest: false};
    await t.seed('io.example/del', '1.0.0', {official: deleted});
    await t.seed('io.example/gone', '1.0.0', {hidden_reason: 'gone-upstream'});
    for (const name of ['io.example/del', 'io.example/gone']) {
      const refused = await put('gw-1', name, '1.0.0', {});
      assert.strictEqual(refused.status, 409, name);
      assert.match(refused.body.detail, /deleted or gone upstream; set the keepDeleted override to enable it/);
      assert.strictEqual((await t.call('POST', `${X}/overrides/${t.enc(name)}/versions/1.0.0`, await t.operator(), {keepDeleted: true})).status, 200);
      assert.strictEqual((await put('gw-1', name, '1.0.0', {})).status, 200, name);
    }
    // A deprecated record stays enable-able.
    await t.seed('io.example/dep', '1.0.0', {official: {...deleted, status: 'deprecated'}});
    assert.strictEqual((await put('gw-1', 'io.example/dep', '1.0.0', {})).status, 200);
  });

  it('a re-PUT records who and when, moves the sequence and sets state requested', async () => {
    await t.seed('io.example/srv', '1.0.0', {remotes: [STREAMABLE(1), STREAMABLE(2)]});
    await put('gw-1', 'io.example/srv', '1.0.0', {});
    const first = await poll('gw-1');
    // The instance validates it, then the operator re-PUTs (a retry, or to approve a change).
    const gw = await t.instance('gw-1');
    const posted = await t.call('POST', `${X}/instances/gw-1/results`, gw, {name: 'io.example/srv', version: '1.0.0', outcome: 'validated', tools: [{name: 'echo', inputSchema: {type: 'object'}}]});
    assert.strictEqual(posted.status, 200, posted.text);
    t.clock.now += 60000;
    const again = await put('gw-1', 'io.example/srv', '1.0.0', {remote: 1});
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.state, 'requested');
    assert.strictEqual(again.body.updatedAt, new Date(t.clock.now).toISOString());
    assert.strictEqual(again.body.by, OPS_FP);
    const next = await poll('gw-1', first.nextSince);
    assert.deepStrictEqual(next.items.map((i) => [i.state, i.remote.url]), [['requested', STREAMABLE(2).url]]);
    assert.ok(BigInt(next.nextSince) > BigInt(first.nextSince));
    const audit = await t.store.read('SELECT key_fp, action, subject FROM audit ORDER BY id');
    assert.deepStrictEqual(audit.map((a) => [a.key_fp, a.action, a.subject]), [
      [OPS_FP, 'enable', 'gw-1 io.example/srv@1.0.0'], [OPS_FP, 'enable', 'gw-1 io.example/srv@1.0.0']]);
  });

  it('DELETE sets disabled and the instance sees it on its next poll', async () => {
    await t.seed('io.example/srv', '1.0.0');
    await put('gw-1', 'io.example/srv', '1.0.0', {});
    const first = await poll('gw-1');
    const del = await t.call('DELETE', t.enablePath('gw-1', 'io.example/srv', '1.0.0'), await t.operator());
    assert.strictEqual(del.status, 200, del.text);
    assert.strictEqual(del.body.state, 'disabled');
    const next = await poll('gw-1', first.nextSince);
    assert.deepStrictEqual(next.items.map((i) => [i.name, i.state]), [['io.example/srv', 'disabled']]);
    // Disabling again is a no-op; an entry never enabled is 404.
    const again = await t.call('DELETE', t.enablePath('gw-1', 'io.example/srv', '1.0.0'), await t.operator());
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await poll('gw-1', next.nextSince)).items.length, 0);
    assert.strictEqual((await t.call('DELETE', t.enablePath('gw-2', 'io.example/srv', '1.0.0'), await t.operator())).status, 404);
  });

  it('the operator listing shows the instance\'s entries with the current result and the history', async () => {
    await t.seed('io.example/srv', '1.0.0');
    await put('gw-1', 'io.example/srv', '1.0.0', {});
    const gw = await t.instance('gw-1');
    const tools = [{name: 'echo', inputSchema: {type: 'object'}}];
    await t.call('POST', `${X}/instances/gw-1/results`, gw, {name: 'io.example/srv', version: '1.0.0', outcome: 'failed', reason: 'timeout'});
    await put('gw-1', 'io.example/srv', '1.0.0', {});
    const ok = await t.call('POST', `${X}/instances/gw-1/results`, gw, {name: 'io.example/srv', version: '1.0.0', outcome: 'validated', tools});
    const res = await t.call('GET', `${X}/instances/gw-1/enabled`, await t.operator());
    assert.strictEqual(res.status, 200, res.text);
    const [item] = res.body.items;
    assert.strictEqual(item.state, 'validated');
    assert.deepStrictEqual(item.result, {outcome: 'validated', sha256: ok.body.sha256, at: item.result.at});
    assert.deepStrictEqual(item.history.map((h) => [h.outcome, h.reason || h.sha256]), [['failed', 'timeout'], ['validated', ok.body.sha256]]);
    // The operator listing is the operator's; an unknown instance is 404.
    assert.strictEqual((await t.call('GET', `${X}/instances/gw-9/enabled`, await t.operator())).status, 404);
  });

  it('a PUT without a body enables with the defaults', async () => {
    await t.seed('io.example/srv', '1.0.0');
    const res = await put('gw-1', 'io.example/srv', '1.0.0', undefined);
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.state, 'requested');
  });

  it('after a re-PUT the operator listing\'s result is the new cycle\'s (null until it has one); history stays whole', async () => {
    await t.seed('io.example/srv', '1.0.0');
    await put('gw-1', 'io.example/srv', '1.0.0', {});
    const gw = await t.instance('gw-1');
    await t.call('POST', `${X}/instances/gw-1/results`, gw, {name: 'io.example/srv', version: '1.0.0', outcome: 'validated', tools: [{name: 'echo', inputSchema: {}}]});
    await put('gw-1', 'io.example/srv', '1.0.0', {});
    const list = async () => (await t.call('GET', `${X}/instances/gw-1/enabled`, await t.operator())).body.items[0];
    let item = await list();
    assert.strictEqual(item.result, null);
    assert.deepStrictEqual(item.history.map((h) => h.outcome), ['validated']);
    await t.call('POST', `${X}/instances/gw-1/results`, gw, {name: 'io.example/srv', version: '1.0.0', outcome: 'failed', reason: 'timeout'});
    item = await list();
    assert.deepStrictEqual([item.result.outcome, item.result.reason], ['failed', 'timeout']);
    assert.deepStrictEqual(item.history.map((h) => h.outcome), ['validated', 'failed']);
  });
});
