'use strict';
// End to end in process: an operator enables an entry, a fake gateway polling
// every 50 ms validates it, and public reads show the aggregate (spec 5.2, 9.6).
const assert = require('assert');
const {startEnableApp, X, OURS, TOOLS} = require('./support/enable-app');
const {createFakeGateway} = require('./support/fake-gateway');

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Every key and string anywhere in a JSON value.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out); }
  return out;
}

describe('the gateway flow', () => {
  let t;
  let gateways = [];
  afterEach(async () => {
    for (const g of gateways) await g.stop();
    gateways = [];
    await t.close();
  });

  const run = async ({publicHosting = 'aggregate'} = {}) => {
    t = await startEnableApp({config: {publicHosting}});
    await t.seed('io.example/srv', '1.0.0');
    const publicBodies = [];
    const read = async (path, token) => {
      const res = await t.call('GET', path, token);
      if (!token) publicBodies.push(res.body);
      return res.body;
    };
    for (const inst of ['gw-1', 'gw-2']) {
      const tok = await t.instance(inst);
      const g = createFakeGateway({call: t.call, X, instance: inst, token: () => tok, toolsFor: () => TOOLS});
      gateways.push(g);
      g.start();
    }
    const detail = `/v0.1/servers/${t.enc('io.example/srv')}/versions/1.0.0`;
    await read(detail);
    const op = await t.operator();
    for (const inst of ['gw-1', 'gw-2']) {
      assert.strictEqual((await t.call('PUT', t.enablePath(inst, 'io.example/srv', '1.0.0'), op, {})).status, 200);
    }
    await until(async () => (await t.store.read("SELECT COUNT(*) AS n FROM enables WHERE state = 'validated'"))[0].n === 2);
    return {read, detail, op, publicBodies};
  };

  it('enable → requested → validated → hosting {hosted: true, instances: 2} on public reads', async () => {
    const {read, detail} = await run();
    assert.deepStrictEqual((await read(detail))._meta[OURS].hosting, {hosted: true, instances: 2});
    const list = await read('/v0.1/servers');
    assert.deepStrictEqual(list.servers[0]._meta[OURS].hosting, {hosted: true, instances: 2});
    // A disable takes the instance out of the count.
    assert.strictEqual((await t.call('DELETE', t.enablePath('gw-2', 'io.example/srv', '1.0.0'), await t.operator())).status, 200);
    assert.deepStrictEqual((await read(detail))._meta[OURS].hosting, {hosted: true, instances: 1});
    // Hosting changes never move changedAt (spec 4.1).
    const [row] = await t.store.read("SELECT changed_at FROM records WHERE name = 'io.example/srv'");
    assert.strictEqual(row.changed_at, '2026-11-10T00:00:00.000Z');
  });

  it('publicHosting none removes hosting from public reads; operator reads keep per-instance detail', async () => {
    const {read, detail, op} = await run({publicHosting: 'none'});
    assert.strictEqual((await read(detail))._meta[OURS].hosting, undefined);
    const opView = (await read(detail, op))._meta[OURS].hosting;
    assert.strictEqual(opView.hosted, true);
    assert.strictEqual(opView.instances, 2);
    assert.deepStrictEqual(opView.byInstance.map((i) => [i.instance, i.state, i.notices]), [['gw-1', 'validated', []], ['gw-2', 'validated', []]]);
    assert.match(opView.byInstance[0].sha256, /^[0-9a-f]{64}$/);
  });

  it('public responses never contain an instance id', async () => {
    const {read, detail, publicBodies} = await run();
    await read(detail);
    await read('/v0.1/servers');
    await read('/v0.1/servers?include_deleted=true');
    await read(`/v0.1/servers/${t.enc('io.example/srv')}/versions`);
    await read(`${X}/mirror`);
    assert.ok(publicBodies.length >= 5);
    for (const body of publicBodies) {
      for (const s of strings(body)) assert.ok(!/gw-[12]/.test(s), `a public body holds ${s}`);
    }
  });
});
