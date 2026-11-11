'use strict';
// Configured public keys and mcp-publisher's signatures (spec section 10.2):
// the same parsing, verification and fingerprints as upstream's
// internal/api/handlers/v0/auth/common.go at 7e8fa024.
const assert = require('assert');
const crypto = require('crypto');
const {parsePublicKey, verifySignature, fingerprint} = require('../lib/auth/keys');
const {edKeyPair, p384KeyPair, ecdsaTwin} = require('./support/keys');

// RFC 8032 section 7.1, TEST 2 (one-byte message 0x72).
const RFC8032 = {
  seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
  publicHex: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
  message: Buffer.from([0x72]),
  signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
};

// What mcp-publisher's InProcessSigner sends: the RFC 3339 timestamp (seconds)
// signed with ed25519.NewKeyFromSeed(<hex seed>), hex-encoded.
function publisherSign(privateHex, algorithm, timestamp) {
  if (algorithm === 'ed25519') {
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(privateHex, 'hex')]);
    const key = crypto.createPrivateKey({key: der, format: 'der', type: 'pkcs8'});
    return crypto.sign(null, Buffer.from(timestamp), key).toString('hex');
  }
  const ecdh = crypto.createECDH('secp384r1');
  ecdh.setPrivateKey(Buffer.from(privateHex, 'hex'));
  const pub = ecdh.getPublicKey();
  const key = crypto.createPrivateKey({format: 'jwk', key: {kty: 'EC', crv: 'P-384',
    d: Buffer.from(privateHex, 'hex').toString('base64url'), x: pub.subarray(1, 49).toString('base64url'), y: pub.subarray(49).toString('base64url')}});
  return crypto.sign('sha384', Buffer.from(timestamp), {key, dsaEncoding: 'ieee-p1363'}).toString('hex');
}

const TS = '2026-11-10T12:00:00Z';

describe('configured keys and signatures', () => {
  it('verifies an ed25519 signature made by mcp-publisher\'s encoding', () => {
    const key = parsePublicKey('ed25519', Buffer.from(RFC8032.publicHex, 'hex').toString('base64'));
    assert.strictEqual(verifySignature(key, 'ed25519', RFC8032.message, RFC8032.signature), true);
    // The seed mcp-publisher takes as --private-key yields that public key.
    const sig = publisherSign(RFC8032.seed, 'ed25519', TS);
    assert.strictEqual(sig.length, 128);
    assert.strictEqual(verifySignature(key, 'ed25519', TS, sig), true);
    assert.strictEqual(verifySignature(key, 'ed25519', TS, sig.toUpperCase()), true, 'Go hex decoding takes either case');
  });

  it('verifies a P-384 signature with a compressed key', () => {
    const prefixes = new Set();
    for (let i = 0; i < 40 && prefixes.size < 2; i++) {
      const kp = p384KeyPair();
      const raw = Buffer.from(kp.publicB64, 'base64');
      assert.strictEqual(raw.length, 49);
      prefixes.add(raw[0]);
      const key = parsePublicKey('ecdsa-p384', kp.publicB64);
      const sig = publisherSign(kp.privateHex, 'ecdsa-p384', TS);
      assert.strictEqual(sig.length, 192);
      assert.strictEqual(verifySignature(key, 'ecdsa-p384', TS, sig), true);
      // ECDSA is malleable: (r, n - s) verifies too, as it does in Go. The replay
      // cache is keyed on the timestamp for this reason (spec 10.2).
      assert.strictEqual(verifySignature(key, 'ecdsa-p384', TS, ecdsaTwin(sig)), true);
    }
    assert.deepStrictEqual([...prefixes].sort(), [2, 3], 'both point parities were exercised');
  });

  it('rejects a wrong-size key', () => {
    const ed = Buffer.alloc(31, 1).toString('base64');
    assert.throws(() => parsePublicKey('ed25519', ed), /invalid Ed25519 public key size/);
    assert.throws(() => parsePublicKey('ed25519', Buffer.alloc(33, 1).toString('base64')), /invalid Ed25519 public key size/);
    const p = Buffer.from(p384KeyPair().publicB64, 'base64');
    assert.throws(() => parsePublicKey('ecdsa-p384', p.subarray(0, 48).toString('base64')), /invalid ECDSA P-384 public key size/);
    const uncompressedTag = Buffer.concat([Buffer.from([0x04]), p.subarray(1)]);
    assert.throws(() => parsePublicKey('ecdsa-p384', uncompressedTag.toString('base64')), /must be compressed, with a leading 0x02 or 0x03 byte/);
    // An x with no point on the curve does not decompress.
    const offCurve = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(48, 0xff)]);
    assert.throws(() => parsePublicKey('ecdsa-p384', offCurve.toString('base64')), /failed to decompress ECDSA P-384 public key/);
    // Base64 as Go's StdEncoding takes it: padded, no stray characters.
    const good = edKeyPair().publicB64;
    assert.throws(() => parsePublicKey('ed25519', good.replace(/=+$/, '')), /failed to decode public key/);
    assert.throws(() => parsePublicKey('ed25519', `${good.slice(0, 4)}\n${good.slice(4)}`), /failed to decode public key/);
    assert.throws(() => parsePublicKey('rsa', good), /unsupported public key algorithm/);
  });

  it('rejects a signature for another timestamp', () => {
    const kp = edKeyPair();
    const key = parsePublicKey('ed25519', kp.publicB64);
    const sig = publisherSign(kp.privateHex, 'ed25519', TS);
    assert.strictEqual(verifySignature(key, 'ed25519', '2026-11-10T12:00:01Z', sig), false);
    assert.strictEqual(verifySignature(key, 'ed25519', TS, sig.slice(0, 126)), false, 'a short signature');
    assert.strictEqual(verifySignature(key, 'ed25519', TS, `${sig.slice(0, 126)}zz`), false, 'not hex');
    assert.strictEqual(verifySignature(key, 'ed25519', TS, `${sig}0`), false, 'odd length');
    const pk = p384KeyPair();
    const pkey = parsePublicKey('ecdsa-p384', pk.publicB64);
    const psig = publisherSign(pk.privateHex, 'ecdsa-p384', TS);
    assert.strictEqual(verifySignature(pkey, 'ecdsa-p384', '2026-11-10T12:00:01Z', psig), false);
    assert.strictEqual(verifySignature(pkey, 'ecdsa-p384', TS, psig.slice(0, 190)), false);
    // A key of one algorithm never verifies as the other.
    assert.strictEqual(verifySignature(key, 'ecdsa-p384', TS, psig), false);
  });

  it('fingerprint matches upstream\'s format', () => {
    const ed = edKeyPair();
    assert.strictEqual(fingerprint(parsePublicKey('ed25519', ed.publicB64)), `ed25519:${ed.publicB64.slice(0, 8)}`);
    const p = p384KeyPair();
    // upstream names the algorithm "ecdsap384" (common.go AlgorithmECDSAP384).
    assert.strictEqual(fingerprint(parsePublicKey('ecdsa-p384', p.publicB64)), `ecdsap384:${p.publicB64.slice(0, 8)}`);
  });
});
