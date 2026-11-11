'use strict';
// The token exchanges (spec 10.2). POST /v0.1/auth/dns and /v0.1/auth/http take
// upstream's payload {domain, timestamp, signed_timestamp} and answer as
// upstream's handlers do (internal/api/handlers/v0/auth/{common,dns,http}.go at
// 7e8fa024): 422 when a JSON body does not decode (a body that is not JSON is
// app.js's 400), 401 "DNS|HTTP authentication
// failed" with the reason in `errors`, else {registry_token, expires_at}. The
// difference: the signature is verified against the key(s) configured for the
// domain, never a DNS TXT record or a well-known file. The instance exchange
// takes {instance, timestamp, signed_timestamp} against that instance's key.
const net = require('net');
const {parsePublicKey, verifySignature, fingerprint, decodeHex, KeyError} = require('./keys');
const {signJwt} = require('./jwt');
const {ConfigError} = require('../config/load');

const SKEW_MS = 15000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DOMAIN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SIG_SIZE = {'ed25519': [64, 'Ed25519'], 'ecdsa-p384': [96, 'ECDSA P-384']};

// status, detail; `errors` as huma's; `reason` and `fields` for the log only.
class ExchangeError extends Error {
  constructor(status, detail, {errors, reason, fields = {}}) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.errors = errors;
    this.reason = reason;
    this.fields = fields;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// huma's decode of a struct of required strings.
function decodeBody(body, fields) {
  if (!isObject(body)) {
    return [{message: 'expected object', location: 'body', value: body === undefined ? null : body}];
  }
  const errors = [];
  for (const k of Object.keys(body)) if (!fields.includes(k)) errors.push({message: 'unexpected property', location: `body.${k}`, value: body});
  for (const f of fields) {
    if (!(f in body)) errors.push({message: `expected required property ${f} to be present`, location: 'body', value: body});
    else if (typeof body[f] !== 'string') errors.push({message: 'expected string', location: `body.${f}`, value: body[f]});
  }
  return errors;
}

// upstream's IsValidDomain.
function validDomain(d) {
  return d.length > 0 && d.length <= 253 && net.isIP(d) === 0 && d.includes('.') && DOMAIN.test(d);
}

function parseKeys(config) {
  const parse = (pointer, algorithm, publicKey) => {
    try {
      return parsePublicKey(algorithm, publicKey);
    } catch (err) {
      if (err instanceof KeyError) throw new ConfigError(pointer, err.message);
      throw err;
    }
  };
  const publishers = (config.publisherKeys || []).map((k, i) => {
    const key = parse(`/publisherKeys/${i}/publicKey`, k.algorithm, k.publicKey);
    return {name: k.name, algorithm: k.algorithm, key, fp: fingerprint(key), domains: k.domains || [],
      perm: {namespaces: [...(k.namespaces || [])], operate: k.operate === true}};
  });
  const instances = new Map((config.instances || []).map((k, i) => {
    const key = parse(`/instances/${i}/publicKey`, k.algorithm, k.publicKey);
    return [k.instance, {instance: k.instance, algorithm: k.algorithm, key, fp: fingerprint(key)}];
  }));
  return {publishers, instances};
}

// config: the loaded config (publisherKeys, instances); secret: Buffer;
// now: () => Date; replay: createReplayCache(). Throws ConfigError for a key
// that does not parse.
function createExchanges({config, secret, now, replay}) {
  const {publishers, instances} = parseKeys(config);

  // upstream's ValidateDomainAndTimestamp's window, and the hex decode.
  const checkTimestamp = (timestamp, fail) => {
    const at = RFC3339.test(timestamp) ? Date.parse(timestamp) : NaN;
    if (Number.isNaN(at)) throw fail('timestamp', 'invalid timestamp format: not an RFC 3339 time');
    const t = now().getTime();
    if (at < t - SKEW_MS || at > t + SKEW_MS) throw fail('timestamp', 'timestamp outside valid window (±15 seconds)');
  };

  // upstream's VerifySignatureWithKeys over the candidate keys.
  const verify = (candidates, timestamp, sigHex, fail) => {
    const sig = decodeHex(sigHex);
    if (!sig) throw fail('signature', 'invalid signature format, must be hex');
    const sized = candidates.filter((c) => sig.length === SIG_SIZE[c.algorithm][0]);
    for (const c of sized) if (verifySignature(c.key, c.algorithm, timestamp, sigHex)) return c;
    // A size error only when no candidate takes a signature of this size.
    if (!sized.length) throw fail('signature', `invalid signature size for ${SIG_SIZE[candidates[candidates.length - 1].algorithm][1]}`);
    const fps = candidates.map((c) => c.fp);
    throw fail('signature', fps.length === 1 ? `signature verification failed (tried configured key ${fps[0]})`
      : `signature verification failed against all ${fps.length} configured keys (tried: ${fps.join(', ')})`);
  };

  const issue = (sub, kind, perm, timestamp, fp, fail) => {
    // Recorded only once the signature verified (spec 10.2).
    if (replay.seen(fp, timestamp)) throw fail('replay', 'this signed timestamp was already used; sign a new one');
    const at = now();
    const token = signJwt({sub, kind, fp, perm}, secret, {now: at});
    return {registry_token: token, expires_at: Math.floor(at.getTime() / 1000) + 300};
  };

  return {
    // method: 'dns' | 'http'. -> {response, log} or throws ExchangeError.
    domain(method, body) {
      const detail = `${method.toUpperCase()} authentication failed`;
      const decoded = decodeBody(body, ['domain', 'timestamp', 'signed_timestamp']);
      if (decoded.length) throw new ExchangeError(422, 'validation failed', {errors: decoded, reason: 'body', fields: {method}});
      const domain = body.domain.toLowerCase();
      let fields = {method, domain};
      const fail = (reason, message) => new ExchangeError(401, detail, {errors: [{message}], reason, fields});
      if (!validDomain(domain)) throw fail('domain', 'invalid domain format');
      checkTimestamp(body.timestamp, fail);
      if (!decodeHex(body.signed_timestamp)) throw fail('signature', 'invalid signature format, must be hex');
      const candidates = publishers.filter((p) => p.domains.includes(domain));
      if (!candidates.length) throw fail('no-key', `no key is configured on this registry for ${domain}; ask its operator to add your public key (the DNS record is never consulted)`);
      const key = verify(candidates, body.timestamp, body.signed_timestamp, fail);
      fields = {...fields, sub: key.name, fingerprint: key.fp};
      const response = issue(key.name, 'publisher', key.perm, body.timestamp, key.fp, fail);
      return {response, log: fields};
    },

    instance(body) {
      const detail = 'Instance authentication failed';
      const decoded = decodeBody(body, ['instance', 'timestamp', 'signed_timestamp']);
      if (decoded.length) throw new ExchangeError(422, 'validation failed', {errors: decoded, reason: 'body', fields: {method: 'instance'}});
      const id = body.instance;
      let fields = {method: 'instance'};
      const fail = (reason, message) => new ExchangeError(401, detail, {errors: [{message}], reason, fields});
      if (!INSTANCE.test(id)) throw fail('instance', 'invalid instance id format');
      fields = {...fields, gateway: id};
      checkTimestamp(body.timestamp, fail);
      const entry = instances.get(id);
      if (!entry) throw fail('no-key', `no instance ${id} is configured on this registry`);
      verify([entry], body.timestamp, body.signed_timestamp, fail);
      fields = {...fields, sub: id, fingerprint: entry.fp};
      const response = issue(id, 'instance', {instance: id}, body.timestamp, entry.fp, fail);
      return {response, log: fields};
    }
  };
}

module.exports = {createExchanges, ExchangeError, parseKeys};
