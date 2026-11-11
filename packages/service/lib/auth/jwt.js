'use strict';
// Registry tokens (spec 10.3): HS256 JWTs made with node:crypto only, valid 5
// minutes. Claims: sub (key name or instance id), kind ('publisher' |
// 'instance'), fp (the key's fingerprint, for audit rows: a prefix of a public
// key, so a token still carries nothing secret), perm ({namespaces, operate} or
// {instance}), iat, exp, jti.
const crypto = require('crypto');

const HEADER = Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url');
const B64URL = /^[A-Za-z0-9_-]+$/;

const mac = (secret, input) => crypto.createHmac('sha256', secret).update(input).digest();

// claims: {sub, kind, fp, perm}. -> the token.
function signJwt(claims, secret, {ttlSec = 300, now = new Date()} = {}) {
  const iat = Math.floor(now.getTime() / 1000);
  const body = {sub: claims.sub, kind: claims.kind, fp: claims.fp, perm: claims.perm, iat, exp: iat + ttlSec, jti: crypto.randomBytes(16).toString('base64url')};
  const input = `${HEADER}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
  return `${input}.${mac(secret, input).toString('base64url')}`;
}

function parsePart(part) {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function wellFormed(c) {
  if (typeof c.sub !== 'string' || typeof c.fp !== 'string' || !Number.isInteger(c.iat) || !Number.isInteger(c.exp) || typeof c.jti !== 'string') return false;
  const p = c.perm;
  if (p === null || typeof p !== 'object') return false;
  if (c.kind === 'publisher') return Array.isArray(p.namespaces) && p.namespaces.every((n) => typeof n === 'string') && typeof p.operate === 'boolean';
  if (c.kind === 'instance') return typeof p.instance === 'string';
  return false;
}

// -> the claims, or null for anything but a well-formed, well-signed, unexpired
// HS256 token. The signature is compared in constant time.
function verifyJwt(token, secret, now = new Date()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null;
  const [h, p, s] = parts;
  const header = parsePart(h);
  if (!header || header.alg !== 'HS256' || Object.keys(header).some((k) => k !== 'alg' && k !== 'typ')) return null;
  const expected = mac(secret, `${h}.${p}`);
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const claims = parsePart(p);
  if (!claims || !wellFormed(claims)) return null;
  if (Math.floor(now.getTime() / 1000) >= claims.exp) return null;
  return claims;
}

module.exports = {signJwt, verifyJwt};
