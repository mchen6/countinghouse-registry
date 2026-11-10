'use strict';
// The log record: one JSON object per line, {t, level, event, msg, source, ...fields}.
// The record definition is copied from countinghouse's logging design
// (github.com/mchen6/countinghouse docs/superpowers/specs/2026-11-09-logger-design.md,
// section 3, at c085892d98a0e5fe3394940be660fa9072fd5def), so an operator running
// both reads one format: the same field names, the same 8 KB bound, and the same
// field-name backstop for secrets (values of secret-named fields become
// "[redacted]" at any depth). The registry adds its own secret names (tokens,
// signatures, private keys, record bodies). Gateway instance ids go in `gateway`:
// countinghouse's `instance` means host:pid:bootid.

const LEVELS = ['debug', 'info', 'warn', 'error'];
const RESERVED = new Set(['t', 'level', 'event', 'msg', 'source']);
// Names are compared lower-cased with '_' and '-' removed, so registryToken,
// registry_token and x-api-key all match. Exact names: countinghouse's list plus
// the registry's own; suffixes catch prefixed forms (accessToken, clientSecret).
const SECRET_NAMES = new Set([
  'apikey', 'appkey', 'key', 'secret', 'token', 'password', 'authorization', 'cookie',
  'registrytoken', 'signature', 'signedtimestamp', 'privatekey', 'record', 'body', 'tools'
]);
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'apikey', 'privatekey', 'signature', 'signedtimestamp'];

function isSecretName(k) {
  const n = k.toLowerCase().replace(/[_-]/g, '');
  return SECRET_NAMES.has(n) || SECRET_SUFFIXES.some((x) => n.endsWith(x));
}
const MAX_RECORD_BYTES = 8192;
const MAX_STRING_BYTES = 2048;

// An Error is logged by name and code only: its message can carry anything
// (paths, upstream bodies), and the record must not.
function redact(value, depth) {
  if (depth > 8) return '[depth]';
  if (value instanceof Error) return value.code ? {name: value.name, code: value.code} : {name: value.name};
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = isSecretName(k) ? '[redacted]' : redact(value[k], depth + 1);
    }
    return out;
  }
  return value;
}

function cut(value, limit) {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value);
    if (bytes <= limit) return value;
    return `${Buffer.from(value).subarray(0, limit).toString('utf8').replace(/�$/, '')}…(${bytes} bytes)`;
  }
  if (Array.isArray(value)) return value.map((v) => cut(v, limit));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = cut(value[k], limit);
    return out;
  }
  return value;
}

// Long strings are cut first; a record still over the bound (many keys, long
// arrays) keeps its fixed fields and says it was truncated, with its size.
function serialise(record) {
  let line = JSON.stringify(record);
  for (let limit = MAX_STRING_BYTES; Buffer.byteLength(line) >= MAX_RECORD_BYTES && limit >= 16; limit = Math.floor(limit / 2)) {
    line = JSON.stringify(cut(record, limit));
  }
  if (Buffer.byteLength(line) >= MAX_RECORD_BYTES) {
    const bytes = Buffer.byteLength(JSON.stringify(record));
    const {t, level, event, msg, source} = record;
    line = JSON.stringify({t, level, event, msg: cut(msg, MAX_STRING_BYTES), source, truncated: true, bytes});
  }
  return `${line}\n`;
}

function createLogger({stream = process.stdout, source = 'registry', now = () => new Date()} = {}) {
  const logger = {};
  for (const level of LEVELS) {
    logger[level] = (event, msg, fields = {}) => {
      const extra = redact(fields, 0);
      const record = {t: now().toISOString(), level, event, msg, source};
      for (const k of Object.keys(extra)) if (!RESERVED.has(k)) record[k] = extra[k];
      stream.write(serialise(record));
    };
  }
  return logger;
}

module.exports = {createLogger};
