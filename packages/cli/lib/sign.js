'use strict';
// Signs a timestamp for the registry's exchanges (spec 10.2), in the encoding
// mcp-publisher's InProcessSigner uses (modelcontextprotocol/registry
// cmd/publisher/auth/common.go at 7e8fa024): the time as RFC 3339 in seconds,
// UTC; the private key as hex (an Ed25519 32-byte seed, or a P-384 48-byte
// scalar); the signature as hex (Ed25519 64 bytes; P-384 r||s, 96 bytes, over
// SHA-384).
const crypto = require('crypto');

const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SIZES = {'ed25519': 32, 'ecdsa-p384': 48};

function privateKeyOf(privateKeyHex, algorithm) {
  if (!(algorithm in SIZES)) throw new Error(`unsupported algorithm ${algorithm}: use ed25519 or ecdsa-p384`);
  const size = SIZES[algorithm];
  if (typeof privateKeyHex !== 'string' || !/^[0-9a-fA-F]*$/.test(privateKeyHex)) throw new Error(`the ${algorithm} private key must be hex`);
  if (privateKeyHex.length !== size * 2) throw new Error(`the ${algorithm} private key must be ${size} bytes (${size * 2} hex characters)`);
  const raw = Buffer.from(privateKeyHex, 'hex');
  if (algorithm === 'ed25519') return crypto.createPrivateKey({key: Buffer.concat([ED25519_PKCS8, raw]), format: 'der', type: 'pkcs8'});
  const ecdh = crypto.createECDH('secp384r1');
  ecdh.setPrivateKey(raw);
  const pub = ecdh.getPublicKey();
  return crypto.createPrivateKey({format: 'jwk', key: {kty: 'EC', crv: 'P-384', d: raw.toString('base64url'),
    x: pub.subarray(1, 49).toString('base64url'), y: pub.subarray(49).toString('base64url')}});
}

// -> {timestamp, signed_timestamp}
function signTimestamp(privateKeyHex, algorithm, now = new Date()) {
  const key = privateKeyOf(privateKeyHex, algorithm);
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const data = Buffer.from(timestamp);
  const sig = algorithm === 'ed25519' ? crypto.sign(null, data, key)
    : crypto.sign('sha384', data, {key, dsaEncoding: 'ieee-p1363'});
  return {timestamp, signed_timestamp: sig.toString('hex')};
}

module.exports = {signTimestamp};
