'use strict';
// Registry tokens (spec 10.3), the replay cache and the exchange rate limit
// (10.2).
const assert = require('assert');
const crypto = require('crypto');
const {signJwt, verifyJwt} = require('../lib/auth/jwt');
const {createReplayCache} = require('../lib/auth/replay');
const {createRateLimiter} = require('../lib/auth/rate-limit');

const SECRET = Buffer.alloc(32, 7);
const T0 = new Date('2026-11-10T12:00:00Z');
const CLAIMS = {sub: 'pub', kind: 'publisher', perm: {namespaces: ['com.example/'], operate: false}};

const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');

describe('registry tokens', () => {
  it('are HS256 JWTs valid for 5 minutes with sub, kind, perm, iat, exp and jti', () => {
    const token = signJwt(CLAIMS, SECRET, {now: T0});
    const [h, p, s] = token.split('.');
    assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), {alg: 'HS256', typ: 'JWT'});
    assert.strictEqual(s, hmac(SECRET, `${h}.${p}`));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.deepStrictEqual(Object.keys(claims).sort(), ['exp', 'iat', 'jti', 'kind', 'perm', 'sub']);
    assert.strictEqual(claims.iat, T0.getTime() / 1000);
    assert.strictEqual(claims.exp, claims.iat + 300);
    assert.match(claims.jti, /^[A-Za-z0-9_-]{22}$/);
    assert.notStrictEqual(signJwt(CLAIMS, SECRET, {now: T0}), token, 'every token has its own jti');
    assert.deepStrictEqual(verifyJwt(token, SECRET, T0), claims);
  });

  it('expire: valid until exp, refused from exp on', () => {
    const token = signJwt(CLAIMS, SECRET, {now: T0});
    assert.ok(verifyJwt(token, SECRET, new Date(T0.getTime() + 299999)));
    assert.strictEqual(verifyJwt(token, SECRET, new Date(T0.getTime() + 300000)), null);
  });

  it('refuse another secret, a changed payload, another algorithm and malformed tokens', () => {
    const token = signJwt(CLAIMS, SECRET, {now: T0});
    const [h, p] = token.split('.');
    assert.strictEqual(verifyJwt(token, Buffer.alloc(32, 8), T0), null);
    const widened = part({...JSON.parse(Buffer.from(p, 'base64url')), perm: {namespaces: [''], operate: true}});
    assert.strictEqual(verifyJwt(`${h}.${widened}.${token.split('.')[2]}`, SECRET, T0), null);
    const none = part({alg: 'none', typ: 'JWT'});
    assert.strictEqual(verifyJwt(`${none}.${p}.`, SECRET, T0), null);
    const hs512 = part({alg: 'HS512', typ: 'JWT'});
    assert.strictEqual(verifyJwt(`${hs512}.${p}.${hmac(SECRET, `${hs512}.${p}`)}`, SECRET, T0), null);
    for (const bad of ['', 'a.b', 'a.b.c.d', `${h}.${p}.***`, `${h}.!!.${hmac(SECRET, `${h}.!!`)}`, null, 42]) {
      assert.strictEqual(verifyJwt(bad, SECRET, T0), null, String(bad));
    }
    // A well-signed payload without the required claims is refused too.
    const bare = part({sub: 'x'});
    assert.strictEqual(verifyJwt(`${h}.${bare}.${hmac(SECRET, `${h}.${bare}`)}`, SECRET, T0), null);
  });
});

describe('the replay cache', () => {
  it('records (fingerprint, timestamp) on first sight and refuses a repeat for 30 s', () => {
    let now = 1000000;
    const cache = createReplayCache({now: () => now});
    assert.strictEqual(cache.seen('ed25519:AAAA', '2026-11-10T12:00:00Z'), false);
    assert.strictEqual(cache.seen('ed25519:AAAA', '2026-11-10T12:00:00Z'), true);
    assert.strictEqual(cache.seen('ed25519:BBBB', '2026-11-10T12:00:00Z'), false, 'another key');
    assert.strictEqual(cache.seen('ed25519:AAAA', '2026-11-10T12:00:01Z'), false, 'another timestamp');
    now += 29999;
    assert.strictEqual(cache.seen('ed25519:AAAA', '2026-11-10T12:00:00Z'), true);
    now += 2;
    assert.strictEqual(cache.seen('ed25519:AAAA', '2026-11-10T12:00:00Z'), false, 'forgotten after the window');
  });

  it('forgets expired entries, so memory stays bounded', () => {
    let now = 0;
    const cache = createReplayCache({now: () => now});
    for (let i = 0; i < 1000; i++) cache.seen('k', `t${i}`);
    now += 31000;
    cache.seen('k', 'fresh');
    assert.strictEqual(cache.size(), 1);
  });
});

describe('the exchange rate limit', () => {
  it('allows 10 per minute per source, then answers with the seconds to wait', () => {
    let now = 0;
    const limiter = createRateLimiter({now: () => now});
    for (let i = 0; i < 10; i++) {
      assert.deepStrictEqual(limiter.take('192.0.2.1'), {ok: true, retryAfterSec: 0});
      now += 1000;
    }
    const refused = limiter.take('192.0.2.1');
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.retryAfterSec, 50);
    assert.strictEqual(limiter.take('192.0.2.2').ok, true, 'another source');
    now = 60000;
    assert.strictEqual(limiter.take('192.0.2.1').ok, true, 'the first request has left the window');
    assert.strictEqual(limiter.take('192.0.2.1').ok, false);
  });

  it('holds at most maxSources sources, dropping the oldest', () => {
    const limiter = createRateLimiter({now: () => 0, maxSources: 100});
    for (let i = 0; i < 1000; i++) limiter.take(`10.1.${i >> 8}.${i & 255}`);
    assert.strictEqual(limiter.size(), 100);
  });

  it('counts an IPv6 /64 as one source', () => {
    const limiter = createRateLimiter({now: () => 0});
    for (let i = 0; i < 10; i++) assert.ok(limiter.take(`2001:db8:1:2::${i.toString(16)}`).ok);
    assert.strictEqual(limiter.take('2001:db8:1:2:ffff:ffff:ffff:ffff').ok, false);
    assert.strictEqual(limiter.take('2001:0db8:0001:0002::abcd').ok, false, 'the same /64 written in full');
    assert.strictEqual(limiter.take('2001:db8:1:3::1').ok, true, 'another /64');
    assert.strictEqual(limiter.take('::ffff:192.0.2.1').ok, true, 'an IPv4-mapped address is that IPv4 address');
    for (let i = 0; i < 9; i++) limiter.take('192.0.2.1');
    assert.strictEqual(limiter.take('::ffff:192.0.2.1').ok, false);
  });

  it('forgets sources idle for a minute', () => {
    let now = 0;
    const limiter = createRateLimiter({now: () => now});
    for (let i = 0; i < 500; i++) limiter.take(`10.0.${i >> 8}.${i & 255}`);
    now = 61000;
    limiter.take('10.9.9.9');
    assert.strictEqual(limiter.size(), 1);
  });
});
