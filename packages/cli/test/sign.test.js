'use strict';
// signTimestamp: what `mcp-publisher login dns|http` and a gateway send to the
// exchanges (spec 10.2): an RFC 3339 timestamp in seconds and its hex signature.
const assert = require('assert');
const crypto = require('crypto');
const {signTimestamp} = require('../lib/sign');

const b64u = (s) => Buffer.from(s, 'base64url');

// Verified here with node:crypto alone (the service's lib/auth/keys.js is the
// registry's side; this package does not depend on it).
function verify(algorithm, publicB64, message, hexSig) {
  const raw = Buffer.from(publicB64, 'base64');
  if (algorithm === 'ed25519') {
    const key = crypto.createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki'});
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(hexSig, 'hex'));
  }
  const point = crypto.ECDH.convertKey(raw, 'secp384r1', undefined, undefined, 'uncompressed');
  const key = crypto.createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-384', x: point.subarray(1, 49).toString('base64url'), y: point.subarray(49).toString('base64url')}});
  return crypto.verify('sha384', Buffer.from(message), {key, dsaEncoding: 'ieee-p1363'}, Buffer.from(hexSig, 'hex'));
}

function pairs() {
  const ed = crypto.generateKeyPairSync('ed25519');
  const edPub = ed.publicKey.export({format: 'jwk'});
  const ec = crypto.generateKeyPairSync('ec', {namedCurve: 'secp384r1'});
  const ecPub = ec.publicKey.export({format: 'jwk'});
  const y = b64u(ecPub.y);
  return [
    {algorithm: 'ed25519', privateHex: b64u(ed.privateKey.export({format: 'jwk'}).d).toString('hex'), publicB64: b64u(edPub.x).toString('base64')},
    {algorithm: 'ecdsa-p384', privateHex: b64u(ec.privateKey.export({format: 'jwk'}).d).toString('hex'),
      publicB64: Buffer.concat([Buffer.from([(y[47] & 1) ? 3 : 2]), b64u(ecPub.x)]).toString('base64')}
  ];
}

describe('signTimestamp', () => {
  it('round-trips with verifySignature for both algorithms', () => {
    // (verify() above does what the service's verifySignature does.)
    const now = new Date('2026-11-10T12:34:56.789Z');
    for (const kp of pairs()) {
      const {timestamp, signed_timestamp: sig} = signTimestamp(kp.privateHex, kp.algorithm, now);
      assert.strictEqual(timestamp, '2026-11-10T12:34:56Z');
      assert.match(sig, /^[0-9a-f]+$/);
      assert.strictEqual(sig.length, kp.algorithm === 'ed25519' ? 128 : 192);
      assert.strictEqual(verify(kp.algorithm, kp.publicB64, timestamp, sig), true, kp.algorithm);
    }
  });

  it('with {millis: true} keeps the milliseconds, so two exchanges in one second differ', () => {
    const now = new Date('2026-11-10T12:34:56.789Z');
    for (const kp of pairs()) {
      const {timestamp, signed_timestamp: sig} = signTimestamp(kp.privateHex, kp.algorithm, now, {millis: true});
      assert.strictEqual(timestamp, '2026-11-10T12:34:56.789Z');
      assert.strictEqual(verify(kp.algorithm, kp.publicB64, timestamp, sig), true, kp.algorithm);
    }
  });

  it('refuses a private key of the wrong length or form', () => {
    assert.throws(() => signTimestamp('ab'.repeat(31), 'ed25519'), /ed25519 private key must be 32 bytes \(64 hex characters\)/);
    assert.throws(() => signTimestamp('ab'.repeat(47), 'ecdsa-p384'), /ecdsa-p384 private key must be 48 bytes \(96 hex characters\)/);
    assert.throws(() => signTimestamp('zz'.repeat(32), 'ed25519'), /hex/);
    assert.throws(() => signTimestamp('ab'.repeat(32), 'rsa'), /unsupported algorithm/);
  });
});
