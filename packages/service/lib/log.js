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
const SECRET_NAMES = new Set([
  // countinghouse's list
  'apikey', 'appkey', 'key', 'secret', 'token', 'password', 'authorization', 'cookie',
  // the registry's additions
  'registry_token', 'signature', 'signed_timestamp', 'privatekey', 'record', 'body', 'tools'
]);
const MAX_RECORD_BYTES = 8192;
const MAX_STRING_BYTES = 2048;

function redact(value, depth) {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SECRET_NAMES.has(k.toLowerCase()) ? '[redacted]' : redact(value[k], depth + 1);
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

function serialise(record) {
  let line = JSON.stringify(record);
  for (let limit = MAX_STRING_BYTES; Buffer.byteLength(line) >= MAX_RECORD_BYTES && limit >= 16; limit = Math.floor(limit / 2)) {
    line = JSON.stringify(cut(record, limit));
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
