'use strict';
// The registry service in process, listening on 9700-9719 under the suite lock
// (`npm test` takes it), with real auth: one publisher/operator key for the
// domain ops.example.org claiming com.example/, and one gateway instance. The
// service is this repository's other workspace, required by path (it depends on
// this package, never the other way round outside tests).
const fs = require('fs');
const os = require('os');
const path = require('path');
const SERVICE = path.join(__dirname, '..', '..', '..', 'service');
const {openStore} = require(path.join(SERVICE, 'lib', 'store'));
const {createApp} = require(path.join(SERVICE, 'lib', 'app'));
const {createLogger} = require(path.join(SERVICE, 'lib', 'log'));
const {createAuth} = require(path.join(SERVICE, 'lib', 'auth', 'middleware'));
const {applyClaims} = require(path.join(SERVICE, 'lib', 'publish', 'namespaces'));
const {listen} = require(path.join(SERVICE, 'test', 'support', 'http'));
const {edKeyPair} = require(path.join(SERVICE, 'test', 'support', 'keys'));

const DOMAIN = 'ops.example.org';
const OPS = edKeyPair();
const GW = edKeyPair();

async function startService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-cli-svc-'));
  const store = await openStore(path.join(dir, 'r.db'));
  const lines = [];
  const log = createLogger({stream: {write: (s) => { lines.push(s); return true; }}});
  const config = {
    listen: {host: '127.0.0.1', port: 9700, trustProxy: false},
    upstreams: [],
    claims: ['com.example/'],
    publisherKeys: [{name: 'ops', algorithm: 'ed25519', publicKey: OPS.publicB64, domains: [DOMAIN], namespaces: ['com.example/'], operate: true}],
    instances: [{instance: 'gw-1', algorithm: 'ed25519', publicKey: GW.publicB64}],
    publicHosting: 'aggregate',
    store: {path: path.join(dir, 'r.db')}
  };
  const auth = createAuth({config, secret: Buffer.from('5c'.repeat(32), 'hex'), log});
  await applyClaims(store, config.claims, new Date().toISOString());
  const server = await listen(createApp({store, config, log, auth}));
  const keyFile = path.join(dir, 'ops.key');
  fs.writeFileSync(keyFile, `${OPS.privateHex}\n`, {mode: 0o600});
  const get = async (p) => {
    const res = await fetch(`${server.url}${p}`);
    return {status: res.status, body: await res.json()};
  };
  return {
    url: server.url, store, logLines: lines, keyFile, domain: DOMAIN, privateHex: OPS.privateHex, get,
    close: async () => { await server.close(); await store.close(); fs.rmSync(dir, {recursive: true, force: true}); }
  };
}

// Captures everything written to stdout and stderr while fn runs.
async function captureOutput(fn) {
  const out = [];
  const orig = {stdout: process.stdout.write, stderr: process.stderr.write};
  process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...rest) => { out.push(String(chunk)); return true; };
  try {
    const value = await fn();
    return {value, text: out.join('')};
  } catch (err) {
    return {error: err, text: out.join('')};
  } finally {
    process.stdout.write = orig.stdout;
    process.stderr.write = orig.stderr;
  }
}

module.exports = {startService, captureOutput, DOMAIN};
