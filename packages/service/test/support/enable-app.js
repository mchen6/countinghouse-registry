'use strict';
// An app with real auth for the enable and instance tests (spec section 9): an
// operator key, two gateway instances, records with remotes, and helpers for
// tokens and calls. In process (test/support/inject.js), no port.
const assert = require('assert');
const {injectApp} = require('./inject');
const {edKeyPair} = require('./keys');
const {insertRecord, server} = require('./records');
const {createAuth} = require('../../lib/auth/middleware');
const {applyClaims} = require('../../lib/publish/namespaces');
const {signTimestamp} = require('countinghouse-registry-cli/lib/sign');

const X = '/v0.1/x/io.github.mchen6/countinghouse-registry';
const OURS = 'io.github.mchen6/countinghouse-registry';
const SECRET = Buffer.from('7a'.repeat(32), 'hex');

const OPS = edKeyPair();
const GW1 = edKeyPair();
const GW2 = edKeyPair();
const OPS_FP = `ed25519:${OPS.publicB64.slice(0, 8)}`;

const CONFIG = {
  claims: ['com.example/'],
  publisherKeys: [{name: 'ops', algorithm: 'ed25519', publicKey: OPS.publicB64, domains: ['ops.example.org'], namespaces: ['com.example/'], operate: true}],
  instances: [{instance: 'gw-1', algorithm: 'ed25519', publicKey: GW1.publicB64}, {instance: 'gw-2', algorithm: 'ed25519', publicKey: GW2.publicB64}]
};

const STREAMABLE = (n = 1) => ({type: 'streamable-http', url: `https://srv${n}.example/mcp`});
const SSE = {type: 'sse', url: 'https://srv.example/sse'};

const remoteServer = (name, version, remotes = [STREAMABLE()]) => server(name, version, {remotes});
const TOOLS = [{name: 'echo', description: 'Echoes', inputSchema: {type: 'object', properties: {text: {type: 'string'}}}}];

async function startEnableApp({config = {}, clock = {now: Date.parse('2026-11-10T12:00:00Z')}} = {}) {
  const t = await injectApp({config: {...CONFIG, ...config}, makeDeps: ({config: cfg, log}) => {
    const now = () => new Date(clock.now);
    return {now, auth: createAuth({config: cfg, secret: SECRET, log, now})};
  }});
  await applyClaims(t.store, t.config.claims, new Date(clock.now).toISOString());
  const tokens = [];
  const exchange = async (path, body) => {
    clock.now += 1000;
    const res = await t.request({method: 'POST', path, body});
    assert.strictEqual(res.status, 200, res.text);
    tokens.push(res.body.registry_token);
    return res.body.registry_token;
  };
  const operator = () => exchange('/v0/auth/dns', {domain: 'ops.example.org', ...signTimestamp(OPS.privateHex, 'ed25519', new Date(clock.now + 1000))});
  const instance = (id) => exchange(`${X}/auth/instance`, {instance: id, ...signTimestamp((id === 'gw-1' ? GW1 : GW2).privateHex, 'ed25519', new Date(clock.now + 1000))});
  const call = (method, path, token, body) => t.request({method, path, body, headers: token ? {authorization: `Bearer ${token}`} : {}});
  const enc = encodeURIComponent;
  const enablePath = (inst, name, version) => `${X}/instances/${inst}/enabled/${enc(name)}/versions/${enc(version)}`;
  const seed = (name, version, {remotes, ...extra} = {}) => insertRecord(t.store, {name, version, server: remoteServer(name, version, remotes), ...extra});
  return {...t, clock, tokens, operator, instance, call, enablePath, seed, enc};
}

module.exports = {startEnableApp, X, OURS, OPS_FP, STREAMABLE, SSE, TOOLS, remoteServer, CONFIG};
