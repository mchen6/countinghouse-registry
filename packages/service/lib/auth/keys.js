'use strict';
// Configured public keys and the signatures mcp-publisher sends (spec 10.2), as
// upstream parses and verifies them (modelcontextprotocol/registry
// internal/api/handlers/v0/auth/common.go at 7e8fa024: ParsePublicKey,
// VerifySignature, Fingerprint). Keys are standard base64 of the raw key:
// Ed25519 32 bytes; ECDSA P-384 the 49-byte compressed point. Signatures are hex:
// Ed25519 64 bytes; P-384 96 bytes r||s over SHA-384. The config names the
// P-384 algorithm "ecdsa-p384"; upstream's name for it, "ecdsap384", is what
// fingerprints print.
const crypto = require('crypto');

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const UPSTREAM_NAME = {'ed25519': 'ed25519', 'ecdsa-p384': 'ecdsap384'};

class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyError';
  }
}

// Go's base64.StdEncoding: padded, the standard alphabet, nothing else.
function decodeStd(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

// -> KeyObject. Throws KeyError with upstream's messages.
function parsePublicKey(algorithm, base64) {
  const raw = decodeStd(base64);
  if (!raw) throw new KeyError('failed to decode public key: not standard base64');
  if (algorithm === 'ed25519') {
    if (raw.length !== 32) throw new KeyError('invalid Ed25519 public key size');
    return crypto.createPublicKey({key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki'});
  }
  if (algorithm === 'ecdsa-p384') {
    if (raw.length !== 49) throw new KeyError('invalid ECDSA P-384 public key size');
    if (raw[0] !== 0x02 && raw[0] !== 0x03) {
      throw new KeyError('invalid ECDSA P-384 public key format (must be compressed, with a leading 0x02 or 0x03 byte)');
    }
    let point;
    try {
      point = crypto.ECDH.convertKey(raw, 'secp384r1', undefined, undefined, 'uncompressed');
    } catch {
      throw new KeyError('failed to decompress ECDSA P-384 public key');
    }
    return crypto.createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-384',
      x: point.subarray(1, 49).toString('base64url'), y: point.subarray(49).toString('base64url')}});
  }
  throw new KeyError(`unsupported public key algorithm: ${algorithm}`);
}

// Go's hex.DecodeString: an even number of hex digits, either case.
function decodeHex(text) {
  return typeof text === 'string' && text.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(text) ? Buffer.from(text, 'hex') : null;
}

function algorithmOf(key) {
  if (key.asymmetricKeyType === 'ed25519') return 'ed25519';
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve === 'secp384r1') return 'ecdsa-p384';
  return null;
}

// -> boolean: false for a malformed signature, the wrong size, a key of the
// other algorithm or a mismatch.
function verifySignature(key, algorithm, message, hexSig) {
  const sig = decodeHex(hexSig);
  if (!sig || algorithmOf(key) !== algorithm) return false;
  const data = Buffer.from(message);
  try {
    if (algorithm === 'ed25519') return sig.length === 64 && crypto.verify(null, data, key, sig);
    if (algorithm === 'ecdsa-p384') return sig.length === 96 && crypto.verify('sha384', data, {key, dsaEncoding: 'ieee-p1363'}, sig);
  } catch {
    return false;
  }
  return false;
}

// The raw key as configured (Ed25519 32 bytes; P-384 compressed).
function rawKey(key) {
  const jwk = key.export({format: 'jwk'});
  if (algorithmOf(key) === 'ed25519') return Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return Buffer.concat([Buffer.from([(y[y.length - 1] & 1) ? 0x03 : 0x02]), Buffer.from(jwk.x, 'base64url')]);
}

// upstream's format: "<algorithm>:<first 8 base64 characters of the raw key>".
function fingerprint(key) {
  const alg = algorithmOf(key);
  if (!alg) return 'unknown:unknown';
  return `${UPSTREAM_NAME[alg]}:${rawKey(key).toString('base64').slice(0, 8)}`;
}

module.exports = {parsePublicKey, verifySignature, fingerprint, decodeHex, KeyError};
