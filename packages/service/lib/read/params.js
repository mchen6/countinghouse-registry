'use strict';
// List parameters, checked in upstream's order and answered with upstream's
// problem bodies (recorded in test/fixtures/upstream): first the type checks of
// the query schema (422 "validation failed" with every error), then the handler's
// checks: updated_since (400), search (422), include_deleted with updated_since (400).

const INTEGER = /^[+-]?\d+$/;
const TRUE = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);
const FALSE = new Set(['0', 'f', 'F', 'FALSE', 'false', 'False']);

const http = require('http');

const problem = (status, detail, extra = {}) => ({
  problem: {title: http.STATUS_CODES[status], status, detail, ...extra}
});

// RFC 3339 as Go's time.Parse(time.RFC3339, ...) accepts it (upstream's parser):
// upper-case T and Z, a real calendar date, hours 0-23, minutes and seconds 0-59,
// optional fraction, Z or a +hh:mm offset.
function parseRfc3339(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return null;
  if (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  if (m[9] !== undefined && (Number(m[10]) > 23 || Number(m[11]) > 59)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function one(value) {
  if (Array.isArray(value)) return value[0];
  return value === undefined || value === '' ? undefined : value;
}

function parseBool(raw, location, errors) {
  if (raw === undefined) return undefined;
  if (TRUE.has(raw)) return true;
  if (FALSE.has(raw)) return false;
  errors.push({message: 'invalid boolean', location, value: raw});
  return undefined;
}

function parseListParams(query) {
  const errors = [];
  const rawLimit = one(query.limit);
  let limit = 30;
  if (rawLimit !== undefined) {
    if (!INTEGER.test(rawLimit)) {
      errors.push({message: 'invalid integer', location: 'query.limit', value: rawLimit});
    } else {
      limit = Number(rawLimit);
      if (limit < 1) errors.push({message: 'expected number >= 1', location: 'query.limit', value: limit});
      else if (limit > 100) errors.push({message: 'expected number <= 100', location: 'query.limit', value: limit});
    }
  }
  const includeDeletedRaw = parseBool(one(query.include_deleted), 'query.include_deleted', errors);
  if (errors.length) return problem(422, 'validation failed', {errors});

  let updatedSince = null;
  const rawSince = one(query.updated_since);
  if (rawSince !== undefined) {
    updatedSince = parseRfc3339(rawSince);
    if (updatedSince === null) return problem(400, 'Invalid updated_since format: expected RFC3339 timestamp (e.g., 2025-08-07T13:15:04.280Z)');
  }

  let search = null;
  const rawSearch = one(query.search);
  if (rawSearch !== undefined) {
    if ([...rawSearch.trim()].length < 3) return problem(422, 'search must contain at least 3 characters after trimming surrounding whitespace');
    search = rawSearch;
  }

  const version = one(query.version) === undefined ? null : one(query.version);

  let includeDeleted = includeDeletedRaw === true;
  if (updatedSince !== null) {
    if (includeDeletedRaw === false) return problem(400, 'Cannot set include_deleted=false when using updated_since (incremental sync requires deleted servers)');
    includeDeleted = true;
  }

  const cursor = one(query.cursor) === undefined ? null : one(query.cursor);
  return {params: {cursor, limit, search, updatedSince, version, includeDeleted}};
}

function parseIncludeDeleted(query) {
  const errors = [];
  const v = parseBool(one(query.include_deleted), 'query.include_deleted', errors);
  if (errors.length) return problem(422, 'validation failed', {errors});
  return {includeDeleted: v === true};
}

module.exports = {parseListParams, parseIncludeDeleted};
