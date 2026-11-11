'use strict';
// The operator commands (spec 12), thin wrappers that sign like publish, against
// the service in process.
const assert = require('assert');
const {main} = require('../bin/countinghouse-registry-cli');
const {register} = require('../lib/commands/register');
const {CURRENT_SCHEMA} = require('../lib/validate');
const {startService} = require('./support/service');
const fs = require('fs');
const os = require('os');
const path = require('path');

function io() {
  const out = [];
  const err = [];
  return {stdout: {write: (s) => out.push(String(s))}, stderr: {write: (s) => err.push(String(s))}, env: {},
    out: () => out.join(''), err: () => err.join('')};
}

describe('operator commands', () => {
  let svc;
  let dir;
  const NAME = 'com.example/remote';
  beforeEach(async () => {
    svc = await startService();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-op-'));
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({$schema: CURRENT_SCHEMA, name: NAME, description: 'A remote server', version: '1.0.0',
      remotes: [{type: 'streamable-http', url: 'https://mcp.example.com/mcp'}]}));
    await register({dir, registry: svc.url, domain: svc.domain, keyFile: svc.keyFile});
  });
  afterEach(async () => { fs.rmSync(dir, {recursive: true, force: true}); await svc.close(); });

  const cli = async (...args) => {
    const t = io();
    const code = await main([...args, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], t);
    return {code, out: t.out(), err: t.err(), json: () => JSON.parse(t.out())};
  };

  it('enable then enabled shows requested', async () => {
    const en = await cli('enable', 'gw-1', NAME, '1.0.0');
    assert.strictEqual(en.code, 0, en.err);
    assert.strictEqual(en.json().state, 'requested');
    const list = await cli('enabled', 'gw-1');
    assert.strictEqual(list.code, 0, list.err);
    assert.deepStrictEqual(list.json().items.map((i) => [i.name, i.version, i.state]), [[NAME, '1.0.0', 'requested']]);
    const dis = await cli('disable', 'gw-1', NAME, '1.0.0');
    assert.strictEqual(dis.code, 0, dis.err);
    assert.strictEqual((await cli('enabled', 'gw-1')).json().items[0].state, 'disabled');
  });

  it('a refusal is exit 1 with status title: detail', async () => {
    const r = await cli('enable', 'gw-9', NAME, '1.0.0');
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.err.trim(), 'PUT /v0.1/x/io.github.mchen6/countinghouse-registry/instances/gw-9/enabled/com.example%2Fremote/versions/1.0.0: 404 Not Found: No instance gw-9 is configured');
  });

  it('override and acknowledge round-trip', async () => {
    // A deleted version takes the keepDeleted override (7.3).
    const del = await fetch(`${svc.url}/v0.1/servers/${encodeURIComponent(NAME)}/versions/1.0.0/status`, {method: 'PATCH',
      headers: {'content-type': 'application/json', authorization: `Bearer ${await token()}`}, body: JSON.stringify({status: 'deleted'})});
    assert.strictEqual(del.status, 200, await del.text());
    const set = await cli('override', NAME, '1.0.0');
    assert.strictEqual(set.code, 0, set.err);
    assert.strictEqual(set.json().keepDeleted, true);
    const removed = await cli('override', NAME, '1.0.0', '--remove');
    assert.strictEqual(removed.code, 0, removed.err);
    assert.match(removed.out, /removed/);
    assert.strictEqual((await cli('override', NAME, '1.0.0', '--remove')).code, 1);

    await svc.store.write((tx) => tx.run('INSERT INTO conflicts (name, version, local_sha, upstream_sha, first_seen) VALUES (?, ?, ?, ?, ?)',
      [NAME, '1.0.0', 'a'.repeat(64), 'b'.repeat(64), '2026-11-11T00:00:00.000Z']));
    const open = await cli('conflicts');
    assert.deepStrictEqual(open.json().conflicts.map((c) => [c.name, c.acknowledgedAt]), [[NAME, null]]);
    const ack = await cli('acknowledge', NAME, '1.0.0');
    assert.strictEqual(ack.code, 0, ack.err);
    assert.ok(ack.json().acknowledgedAt);
    assert.ok((await cli('conflicts')).json().conflicts[0].acknowledgedBy.startsWith('ed25519:'));
  });

  it('sync answers the service (no upstreams here: 404)', async () => {
    const r = await cli('sync');
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /404 Not Found: No upstreams are configured/);
  });

  it('a missing argument is exit 1 with the usage of that command', async () => {
    const r = await cli('enable', 'gw-1', NAME);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /usage: countinghouse-registry-cli enable <instance> <name> <version>/);
  });

  async function token() {
    const {exchange} = require('../lib/client');
    const {createClient} = require('../lib/client');
    return exchange(createClient({registry: svc.url}), {domain: svc.domain, privateKeyHex: svc.privateHex, algorithm: 'ed25519'});
  }
});
