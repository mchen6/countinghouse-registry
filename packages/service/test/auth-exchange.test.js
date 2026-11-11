'use strict';
// The exchanges and tokens end to end (spec sections 10.1-10.3), in process:
// mcp-publisher's login dns|http payloads, the instance exchange, replay, skew,
// rate limits, token scope and expiry, and the logs.
const assert = require('assert');
const express = require('express');
const http = require('http');
const {injectApp, inject} = require('./support/inject');
const {edKeyPair, p384KeyPair, ecdsaTwin} = require('./support/keys');
const {createAuth} = require('../lib/auth/middleware');
const {applyClaims} = require('../lib/publish/namespaces');
const {signTimestamp} = require('countinghouse-registry-cli/lib/sign');

const X = '/v0.1/x/io.github.mchen6/countinghouse-registry';
const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const SECRET = Buffer.from('5e'.repeat(32), 'hex');
const T0 = Date.parse('2026-11-10T12:00:00Z');

const PUB = edKeyPair();
const OPS = p384KeyPair();
const GW1 = edKeyPair();
const GW2 = p384KeyPair();

const CONFIG = {
  claims: ['com.example/'],
  publisherKeys: [
    {name: 'pub', algorithm: 'ed25519', publicKey: PUB.publicB64, domains: ['example.com'], namespaces: ['com.example/'], operate: false},
    {name: 'ops', algorithm: 'ecdsa-p384', publicKey: OPS.publicB64, domains: ['ops.example.org'], namespaces: [], operate: true}
  ],
  instances: [
    {instance: 'gw-1', algorithm: 'ed25519', publicKey: GW1.publicB64},
    {instance: 'gw-2', algorithm: 'ecdsa-p384', publicKey: GW2.publicB64}
  ]
};

const server = (name, version = '1.0.0') => ({$schema: SCHEMA, name, description: 'A test server', version});
const payload = (kp, extra, at) => ({...extra, ...signTimestamp(kp.privateHex, kp.algorithm, new Date(at))});
const bearer = (token) => ({authorization: `Bearer ${token}`});
const tokenClaims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));

describe('the auth exchanges', () => {
  let t;
  let clock;
  const start = async ({config = CONFIG, secret = SECRET} = {}) => {
    t = await injectApp({config, makeDeps: ({config: cfg, log}) => {
      const now = () => new Date(clock);
      return {now, auth: createAuth({config: cfg, secret, log, now})};
    }});
    await applyClaims(t.store, t.config.claims, new Date(clock).toISOString());
    return t;
  };
  beforeEach(() => { clock = T0; });
  afterEach(async () => { if (t) await t.close(); t = null; });

  const post = (path, body, opts = {}) => t.request({method: 'POST', path, body, ...opts});
  const login = async (method = 'dns', at = clock) => {
    const res = await post(`/v0/auth/${method}`, payload(PUB, {domain: 'example.com'}, at));
    assert.strictEqual(res.status, 200, res.text);
    return res.body.registry_token;
  };

  it('dns exchange returns {registry_token, expires_at} for a configured domain key', async () => {
    await start();
    const res = await post('/v0/auth/dns', payload(PUB, {domain: 'example.com'}, clock));
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.headers['content-type'], 'application/json');
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['expires_at', 'registry_token']);
    assert.strictEqual(res.body.expires_at, T0 / 1000 + 300);
    const claims = tokenClaims(res.body.registry_token);
    assert.strictEqual(claims.sub, 'pub');
    assert.strictEqual(claims.kind, 'publisher');
    assert.deepStrictEqual(claims.perm, {namespaces: ['com.example/'], operate: false});
    // The token publishes into the key's namespace, as mcp-publisher does next.
    const pub = await post('/v0/publish', server('com.example/weather'), {headers: bearer(res.body.registry_token)});
    assert.strictEqual(pub.status, 200, pub.text);
    // ...and only there.
    const other = await post('/v0/publish', server('org.other/weather'), {headers: bearer(res.body.registry_token)});
    assert.strictEqual(other.status, 403);
    // The domain is matched without regard to case, as DNS names are.
    clock += 1000;
    assert.strictEqual((await post('/v0.1/auth/dns', payload(PUB, {domain: 'Example.COM'}, clock))).status, 200);
  });

  it('http exchange behaves the same', async () => {
    await start();
    const res = await post('/v0.1/auth/http', payload(OPS, {domain: 'ops.example.org'}, clock));
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.expires_at, T0 / 1000 + 300);
    assert.deepStrictEqual(tokenClaims(res.body.registry_token).perm, {namespaces: [], operate: true});
  });

  it('refuses a key not configured for the domain, and a wrong signature, with upstream\'s 401 shape', async () => {
    await start();
    const unknown = await post('/v0/auth/dns', payload(PUB, {domain: 'other.example'}, clock));
    assert.strictEqual(unknown.status, 401);
    assert.strictEqual(unknown.headers['content-type'], 'application/problem+json');
    assert.strictEqual(unknown.body.title, 'Unauthorized');
    assert.strictEqual(unknown.body.detail, 'DNS authentication failed');
    assert.match(unknown.body.errors[0].message, /no key is configured on this registry for other\.example/);
    // Signed by another key: the message names the configured key's fingerprint only.
    const wrong = await post('/v0/auth/http', payload(edKeyPair(), {domain: 'example.com'}, clock));
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.body.detail, 'HTTP authentication failed');
    assert.match(wrong.body.errors[0].message, new RegExp(`signature verification failed \\(tried configured key ed25519:${PUB.publicB64.slice(0, 8).replace(/[+/]/g, '\\$&')}\\)`));
    const notHex = await post('/v0/auth/dns', {domain: 'example.com', timestamp: new Date(clock).toISOString().replace(/\.\d+Z$/, 'Z'), signed_timestamp: 'xyz'});
    assert.strictEqual(notHex.status, 401);
    assert.match(notHex.body.errors[0].message, /invalid signature format, must be hex/);
    // A signature of the other algorithm's size is upstream's structural error.
    const size = await post('/v0/auth/http', payload(OPS, {domain: 'example.com'}, clock));
    assert.match(size.body.errors[0].message, /invalid signature size for Ed25519/);
  });

  it('decodes the body as upstream\'s huma does: 422 for a missing, mistyped or unknown property', async () => {
    await start();
    const good = payload(PUB, {domain: 'example.com'}, clock);
    const missing = await post('/v0/auth/dns', {domain: good.domain, timestamp: good.timestamp});
    assert.strictEqual(missing.status, 422);
    assert.strictEqual(missing.body.detail, 'validation failed');
    assert.deepStrictEqual(missing.body.errors.map((e) => [e.message, e.location]), [['expected required property signed_timestamp to be present', 'body']]);
    const typed = await post('/v0/auth/dns', {...good, domain: 7});
    assert.deepStrictEqual(typed.body.errors.map((e) => [e.message, e.location]), [['expected string', 'body.domain']]);
    const extra = await post('/v0/auth/dns', {...good, scope: 'all'});
    assert.deepStrictEqual(extra.body.errors.map((e) => [e.message, e.location]), [['unexpected property', 'body.scope']]);
    assert.strictEqual((await post('/v0/auth/dns', [good])).status, 422);
    const domain = await post('/v0/auth/dns', {...good, domain: 'localhost'});
    assert.strictEqual(domain.status, 401);
    assert.match(domain.body.errors[0].message, /invalid domain format/);
  });

  it('refuses a timestamp outside ±15 s', async () => {
    await start();
    for (const skew of [-16000, 16000]) {
      const res = await post('/v0/auth/dns', payload(PUB, {domain: 'example.com'}, clock + skew));
      assert.strictEqual(res.status, 401, `skew ${skew}`);
      assert.match(res.body.errors[0].message, /timestamp outside valid window \(±15 seconds\)/);
    }
    for (const skew of [-15000, 15000]) {
      assert.strictEqual((await post('/v0/auth/dns', payload(PUB, {domain: 'example.com'}, clock + skew))).status, 200, `skew ${skew}`);
    }
    const res = await post('/v0/auth/dns', {...payload(PUB, {domain: 'example.com'}, clock), timestamp: 'yesterday'});
    assert.match(res.body.errors[0].message, /invalid timestamp format/);
  });

  it('refuses a replay of the same key and timestamp', async () => {
    await start();
    const body = payload(PUB, {domain: 'example.com'}, clock);
    assert.strictEqual((await post('/v0/auth/dns', body)).status, 200);
    const again = await post('/v0/auth/http', body);
    assert.strictEqual(again.status, 401);
    assert.match(again.body.errors[0].message, /this signed timestamp was already used; sign a new one/);
  });

  it('refuses the ECDSA (r, n−s) twin of a used signature', async () => {
    await start();
    const body = payload(OPS, {domain: 'ops.example.org'}, clock);
    assert.strictEqual((await post('/v0/auth/dns', body)).status, 200);
    const twin = {...body, signed_timestamp: ecdsaTwin(body.signed_timestamp)};
    assert.notStrictEqual(twin.signed_timestamp, body.signed_timestamp);
    const res = await post('/v0/auth/dns', twin);
    assert.strictEqual(res.status, 401);
    assert.match(res.body.errors[0].message, /already used/);
  });

  it('rate limits the exchange routes per source with Retry-After', async () => {
    await start();
    for (let i = 0; i < 10; i++) {
      const res = await post(i % 2 ? '/v0/auth/dns' : `${X}/auth/instance`, {}, {remoteAddress: '198.51.100.7'});
      assert.strictEqual(res.status, 422);
    }
    const limited = await post('/v0/auth/http', payload(PUB, {domain: 'example.com'}, clock), {remoteAddress: '198.51.100.7'});
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.headers['content-type'], 'application/problem+json');
    assert.strictEqual(limited.headers['retry-after'], '60');
    assert.match(limited.body.detail, /Too many authentication requests; retry after 60 seconds/);
    assert.strictEqual((await post('/v0/auth/http', payload(PUB, {domain: 'example.com'}, clock), {remoteAddress: '198.51.100.8'})).status, 200);
  });

  it('rate limits by the forwarded address when trustProxy is set, by the socket address otherwise', async () => {
    const run = async (trustProxy) => {
      await start({config: {...CONFIG, listen: {trustProxy}}});
      const statuses = {a: [], b: []};
      for (let i = 0; i < 11; i++) {
        for (const [who, xff] of [['a', '203.0.113.1'], ['b', '203.0.113.2']]) {
          const res = await post('/v0/auth/dns', {}, {remoteAddress: '10.0.0.1', headers: {'x-forwarded-for': xff}});
          statuses[who].push(res.status);
        }
      }
      await t.close();
      t = null;
      return statuses;
    };
    const trusted = await run(true);
    assert.deepStrictEqual(trusted.a, [...Array(10).fill(422), 429], 'each client has its own 10');
    assert.deepStrictEqual(trusted.b, [...Array(10).fill(422), 429]);
    const untrusted = await run(false);
    const all = untrusted.a.map((s, i) => [s, untrusted.b[i]]).flat();
    assert.deepStrictEqual(all, [...Array(10).fill(422), ...Array(12).fill(429)], 'one proxy address shares 10');
  });

  it('with trustProxy, the address the proxy appended counts, not one the client wrote', async () => {
    // nginx's proxy_add_x_forwarded_for appends the client's address to whatever
    // X-Forwarded-For the client sent: only the last entry is the proxy's word.
    await start({config: {...CONFIG, listen: {trustProxy: true}}});
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const res = await post('/v0/auth/dns', {}, {remoteAddress: '10.0.0.1', headers: {'x-forwarded-for': `198.18.0.${i}, 203.0.113.5`}});
      statuses.push(res.status);
    }
    assert.deepStrictEqual(statuses, [...Array(10).fill(422), 429], 'a client cannot pick a fresh bucket per request');
  });

  it('a body that is not JSON is 400, as on every write route', async () => {
    await start();
    const res = await post('/v0/auth/dns', '{bad');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.detail, 'The request body is not valid JSON');
  });

  it('a domain with keys of both algorithms reports a mismatch, not a size error, for a signature of the right size', async () => {
    const other = p384KeyPair();
    const config = {...CONFIG, publisherKeys: [...CONFIG.publisherKeys,
      {name: 'pub-p384', algorithm: 'ecdsa-p384', publicKey: OPS.publicB64, domains: ['example.com'], namespaces: [], operate: false}]};
    await start({config});
    const res = await post('/v0/auth/dns', payload(other, {domain: 'example.com'}, clock));
    assert.strictEqual(res.status, 401);
    assert.match(res.body.errors[0].message, /signature verification failed against all 2 configured keys/);
  });

  it('github-at, github-oidc, oidc and none are 404 naming the supported methods', async () => {
    await start();
    for (const m of ['github-at', 'github-oidc', 'oidc', 'none']) {
      for (const prefix of ['/v0', '/v0.1']) {
        const res = await post(`${prefix}/auth/${m}`, {});
        assert.strictEqual(res.status, 404, `${prefix} ${m}`);
        assert.strictEqual(res.headers['content-type'], 'application/problem+json');
        assert.strictEqual(res.body.detail, `This registry does not offer ${m} authentication; use dns or http (mcp-publisher login dns|http) with a key configured for your domain`);
      }
    }
  });

  it('instance exchange issues an instance token only for that instance', async () => {
    await start();
    const res = await post(`${X}/auth/instance`, payload(GW1, {instance: 'gw-1'}, clock));
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.expires_at, T0 / 1000 + 300);
    const claims = tokenClaims(res.body.registry_token);
    assert.strictEqual(claims.sub, 'gw-1');
    assert.strictEqual(claims.kind, 'instance');
    assert.deepStrictEqual(claims.perm, {instance: 'gw-1'});
    // gw-1's key cannot claim gw-2, and an unknown instance is refused.
    const as2 = await post(`${X}/auth/instance`, payload(GW1, {instance: 'gw-2'}, clock + 1000));
    assert.strictEqual(as2.status, 401);
    assert.strictEqual(as2.body.detail, 'Instance authentication failed');
    const unknown = await post(`${X}/auth/instance`, payload(GW1, {instance: 'gw-9'}, clock + 2000));
    assert.strictEqual(unknown.status, 401);
    assert.match(unknown.body.errors[0].message, /no instance gw-9 is configured on this registry/);
    // The P-384 instance works the same.
    assert.strictEqual((await post(`/v0/x/io.github.mchen6/countinghouse-registry/auth/instance`, payload(GW2, {instance: 'gw-2'}, clock))).status, 200);
    // Instances never use the domain exchanges: an instance key is not a domain key.
    assert.strictEqual((await post('/v0/auth/dns', payload(GW1, {domain: 'example.com'}, clock + 3000))).status, 401);
  });

  it('a publisher token cannot call an instance route and vice versa', async () => {
    await start();
    const pubToken = await login();
    const gwToken = (await post(`${X}/auth/instance`, payload(GW1, {instance: 'gw-1'}, clock))).body.registry_token;
    const opsToken = (await post('/v0/auth/http', payload(OPS, {domain: 'ops.example.org'}, clock))).body.registry_token;
    // An instance route as Task 8 will mount it, guarded by the same auth.
    const app = express();
    app.get('/instance/:id', t.deps.auth.require((req) => `instance:${req.params.id}`), (req, res) => res.json({ok: req.actor.instance}));
    app.get('/operate', t.deps.auth.require('operate'), (req, res) => res.json({ok: req.actor.sub}));
    const probe = http.createServer(app);
    const get = (p, token) => inject(probe, {path: p, headers: token ? bearer(token) : {}});
    assert.strictEqual((await get('/instance/gw-1', gwToken)).status, 200);
    assert.strictEqual((await get('/instance/gw-2', gwToken)).status, 403, 'only its own instance');
    assert.strictEqual((await get('/instance/gw-1', pubToken)).status, 403);
    assert.strictEqual((await get('/instance/gw-1', opsToken)).status, 403);
    assert.strictEqual((await get('/operate', opsToken)).status, 200);
    assert.strictEqual((await get('/operate', pubToken)).status, 403);
    assert.strictEqual((await get('/operate', gwToken)).status, 403);
    assert.strictEqual((await get('/operate')).status, 401);
    const pub = await post('/v0/publish', server('com.example/gw'), {headers: bearer(gwToken)});
    assert.strictEqual(pub.status, 403);
    assert.match(pub.body.detail, /You do not have permission to publish this server/);
  });

  it('an expired token is 401', async () => {
    await start();
    const token = await login();
    clock = T0 + 299000;
    assert.strictEqual((await post('/v0/publish', server('com.example/a1'), {headers: bearer(token)})).status, 200);
    clock = T0 + 300000;
    const res = await post('/v0/publish', server('com.example/a2'), {headers: bearer(token)});
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.detail, 'Invalid or expired Registry JWT token');
    for (const h of [{authorization: 'Bearer'}, {authorization: `Basic ${token}`}, {authorization: `Bearer ${token}x`}]) {
      assert.strictEqual((await post('/v0/publish', server('com.example/a3'), {headers: h})).status, 401);
    }
  });

  it('a token from a removed key keeps working until it expires', async () => {
    await start();
    const token = await login();
    await t.close();
    // The key is removed from config and the registry restarted (same secret).
    await start({config: {...CONFIG, publisherKeys: CONFIG.publisherKeys.slice(1)}});
    clock = T0 + 60000;
    assert.strictEqual((await post('/v0/publish', server('com.example/kept'), {headers: bearer(token)})).status, 200);
    // New exchanges with the removed key are refused at once.
    assert.strictEqual((await post('/v0/auth/dns', payload(PUB, {domain: 'example.com'}, clock))).status, 401);
    clock = T0 + 300000;
    assert.strictEqual((await post('/v0/publish', server('com.example/gone'), {headers: bearer(token)})).status, 401);
    // A token signed with another secret is never accepted.
    await t.close();
    await start({secret: Buffer.alloc(32, 1)});
    clock = T0 + 1000;
    assert.strictEqual((await post('/v0/publish', server('com.example/other'), {headers: bearer(token)})).status, 401);
  });

  it('no token, signature or key appears in captured logs', async () => {
    await start();
    const secrets = [SECRET.toString('hex'), SECRET.toString('base64')];
    for (const kp of [PUB, OPS, GW1, GW2]) secrets.push(kp.privateHex, kp.publicB64);
    const send = async (path, body) => {
      secrets.push(body.signed_timestamp);
      const res = await post(path, body);
      if (res.body && res.body.registry_token) secrets.push(res.body.registry_token, ...res.body.registry_token.split('.'));
      return res;
    };
    await send('/v0/auth/dns', payload(PUB, {domain: 'example.com'}, clock));
    await send('/v0/auth/dns', payload(PUB, {domain: 'example.com'}, clock)); // replay
    await send('/v0/auth/http', payload(OPS, {domain: 'ops.example.org'}, clock));
    await send('/v0/auth/http', payload(OPS, {domain: 'example.com'}, clock)); // wrong key
    await send('/v0/auth/dns', payload(PUB, {domain: 'example.com'}, clock - 60000)); // skew
    await send(`${X}/auth/instance`, payload(GW1, {instance: 'gw-1'}, clock));
    await send(`${X}/auth/instance`, payload(GW1, {instance: 'gw-2'}, clock)); // wrong key
    const tok = secrets[secrets.length - 1];
    await post('/v0/publish', server('com.example/logged'), {headers: bearer(tok)});
    const logs = t.logLines.join('');
    for (const s of secrets) assert.ok(!logs.includes(s), `a log line holds ${s.slice(0, 6)}…`);
    // The exchanges are logged, by fingerprint.
    const events = t.logLines.map((l) => JSON.parse(l));
    const ok = events.filter((e) => e.event === 'auth.exchange');
    assert.deepStrictEqual(ok.map((e) => [e.method, e.sub, e.fingerprint]),
      [['dns', 'pub', `ed25519:${PUB.publicB64.slice(0, 8)}`], ['http', 'ops', `ecdsap384:${OPS.publicB64.slice(0, 8)}`], ['instance', 'gw-1', `ed25519:${GW1.publicB64.slice(0, 8)}`]]);
    const refused = events.filter((e) => e.event === 'auth.exchange.refused');
    assert.deepStrictEqual(refused.map((e) => e.reason), ['replay', 'signature', 'timestamp', 'signature']);
  });
});
