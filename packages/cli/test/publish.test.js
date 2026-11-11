'use strict';
// publish (spec 11.5) against the service in process: a dns-style exchange, the
// record PUT, then POST /v0.1/publish.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {generate} = require('../lib/commands/generate');
const {publish} = require('../lib/commands/publish');
const {main} = require('../bin/countinghouse-registry-cli');
const {recordHash} = require('../lib/record');
const {moduleCopy, validateOk, fixtureTools} = require('./support/module');
const {startService, captureOutput} = require('./support/service');

const OURS = 'io.github.mchen6/countinghouse-registry';
const X = '/v0.1/x/io.github.mchen6/countinghouse-registry';

// A fetch that records every registry_token the service hands out.
function tokenSpy() {
  const tokens = [];
  const spy = async (...args) => {
    const res = await fetch(...args);
    const text = await res.clone().text();
    const m = /"registry_token":"([^"]+)"/.exec(text);
    if (m) tokens.push(m[1]);
    return res;
  };
  return {fetch: spy, tokens};
}

function io(extra = {}) {
  const chunks = [];
  const w = {write: (s) => { chunks.push(String(s)); return true; }};
  return {stdout: w, stderr: w, env: {}, text: () => chunks.join(''), ...extra};
}

describe('publish', () => {
  let svc;
  let m;
  beforeEach(async () => {
    svc = await startService();
    m = moduleCopy();
    await generate({dir: m.dir, registry: svc.url, exec: validateOk().exec, toolsList: fixtureTools});
  });
  afterEach(async () => { m.remove(); await svc.close(); });

  it('exchanges, PUTs the record, then publishes; the record is served with origin local and the record hash', async () => {
    const out = await publish({dir: m.dir, registry: svc.url, domain: svc.domain, keyFile: svc.keyFile});
    const record = JSON.parse(fs.readFileSync(path.join(m.dir, 'countinghouse-record.json'), 'utf8'));
    const sha256 = recordHash(record);
    assert.deepStrictEqual(out, {name: 'com.example/echo', version: '1.0.0', record: {status: 201, sha256}, published: true});
    const served = await svc.get(`/v0.1/servers/${encodeURIComponent('com.example/echo')}/versions/1.0.0`);
    assert.strictEqual(served.status, 200);
    assert.strictEqual(served.body._meta[OURS].origin, 'local');
    assert.deepStrictEqual(served.body._meta[OURS].record, {sha256, recordVersion: 1});
    const stored = await svc.get(`${X}/records/${encodeURIComponent('com.example/echo')}/versions/1.0.0`);
    assert.deepStrictEqual(stored.body, record);
  });

  it('a second publish of the same version answers the service\'s refusal, after an identical record PUT (200)', async () => {
    await publish({dir: m.dir, registry: svc.url, domain: svc.domain, keyFile: svc.keyFile});
    await assert.rejects(publish({dir: m.dir, registry: svc.url, domain: svc.domain, keyFile: svc.keyFile}), (err) => {
      assert.strictEqual(err.exitCode, 1);
      assert.match(err.message, /^POST \/v0\.1\/publish: 4\d\d [A-Z][\w ]+: /);
      return true;
    });
  });

  it('reads the private key from COUNTINGHOUSE_REGISTRY_PRIVATE_KEY', async () => {
    const out = await publish({dir: m.dir, registry: svc.url, domain: svc.domain, env: {COUNTINGHOUSE_REGISTRY_PRIVATE_KEY: svc.privateHex}});
    assert.strictEqual(out.published, true);
  });

  it('refuses both a key file and the environment variable, and neither', async () => {
    await assert.rejects(publish({dir: m.dir, registry: svc.url, domain: svc.domain, keyFile: svc.keyFile, env: {COUNTINGHOUSE_REGISTRY_PRIVATE_KEY: svc.privateHex}}), /give the key once: --key or COUNTINGHOUSE_REGISTRY_PRIVATE_KEY, not both/);
    await assert.rejects(publish({dir: m.dir, registry: svc.url, domain: svc.domain, env: {}}), /needs a private key: --key <file> or COUNTINGHOUSE_REGISTRY_PRIVATE_KEY/);
  });

  it('fails loudly with both hash prefixes when the record on disk does not match the pointer', async () => {
    const file = path.join(m.dir, 'countinghouse-record.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pointer = JSON.parse(fs.readFileSync(path.join(m.dir, 'server.json'), 'utf8'))._meta['io.modelcontextprotocol.registry/publisher-provided']['io.github.mchen6.countinghouse'].sha256;
    record.calls = ['other/thing'];
    fs.writeFileSync(file, JSON.stringify(record));
    const onDisk = recordHash(record);
    await assert.rejects(publish({dir: m.dir, registry: svc.url, domain: svc.domain, keyFile: svc.keyFile}), (err) => {
      assert.strictEqual(err.exitCode, 1);
      assert.ok(err.message.includes(onDisk.slice(0, 12)), err.message);
      assert.ok(err.message.includes(pointer.slice(0, 12)), err.message);
      assert.match(err.message, /^the record on disk \(sha256 [0-9a-f]{12}…\) does not match the pointer in server\.json \(sha256 [0-9a-f]{12}…\): run generate again$/);
      return true;
    });
    // Nothing reached the registry.
    assert.strictEqual((await svc.get(`${X}/records/${encodeURIComponent('com.example/echo')}/versions/1.0.0`)).status, 404);
  });

  it('never prints the private key or the token (capture stdout and stderr)', async () => {
    const spy = tokenSpy();
    const ok = io({fetch: spy.fetch});
    const okRun = await captureOutput(() => main(['publish', m.dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], ok));
    assert.strictEqual(okRun.value, 0, ok.text());
    assert.match(ok.text(), /published com\.example\/echo@1\.0\.0/);
    // A failing run too: the same version again.
    const bad = io({fetch: spy.fetch});
    const badRun = await captureOutput(() => main(['publish', m.dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], bad));
    assert.strictEqual(badRun.value, 1);
    // A refused exchange (a domain no key holds).
    const refused = io({fetch: spy.fetch});
    const refusedRun = await captureOutput(() => main(['publish', m.dir, '--registry', svc.url, '--domain', 'other.example.org', '--key', svc.keyFile], refused));
    assert.strictEqual(refusedRun.value, 1);
    assert.match(refused.text(), /401/);
    assert.ok(spy.tokens.length >= 2);
    const all = [ok.text(), bad.text(), refused.text(), okRun.text, badRun.text, refusedRun.text, ...svc.logLines].join('\n');
    assert.ok(!all.includes(svc.privateHex), 'the private key was printed');
    for (const t of spy.tokens) {
      assert.ok(!all.includes(t), 'a token was printed');
      for (const part of t.split('.')) assert.ok(!all.includes(part), 'a token part was printed');
    }
  });
});
