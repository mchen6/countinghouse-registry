'use strict';
// Key pairs in the forms mcp-publisher and the config use: the private key as
// hex (an Ed25519 seed, or a P-384 scalar), the public key as standard base64
// of the raw key (32 bytes for Ed25519; for P-384 the 49-byte compressed point).
const crypto = require('crypto');

const b64u = (s) => Buffer.from(s, 'base64url');

function edKeyPair() {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({format: 'jwk'});
  const priv = privateKey.export({format: 'jwk'});
  return {algorithm: 'ed25519', privateHex: b64u(priv.d).toString('hex'), publicB64: b64u(pub.x).toString('base64')};
}

function p384KeyPair() {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'secp384r1'});
  const pub = publicKey.export({format: 'jwk'});
  const priv = privateKey.export({format: 'jwk'});
  const x = b64u(pub.x);
  const y = b64u(pub.y);
  const compressed = Buffer.concat([Buffer.from([(y[y.length - 1] & 1) ? 0x03 : 0x02]), x]);
  return {algorithm: 'ecdsa-p384', privateHex: b64u(priv.d).toString('hex'), publicB64: compressed.toString('base64')};
}

// P-384's group order n, for the (r, n - s) twin of a signature.
const P384_N = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973');

function ecdsaTwin(hexSig) {
  const r = hexSig.slice(0, 96);
  const s = BigInt(`0x${hexSig.slice(96)}`);
  return r + (P384_N - s).toString(16).padStart(96, '0');
}

module.exports = {edKeyPair, p384KeyPair, ecdsaTwin, P384_N};
