'use strict';
// The countinghouse record (spec section 8): validation against its own JSON Schema
// (2020-12, closed envelope), its hash, and the pointer server.json carries to it.
const Ajv2020 = require('ajv/dist/2020');
const schema = require('../schemas/record.schema.json');
const {sha256Canonical, depthWithin} = require('./canonical-json');

const MAX_DEPTH = 64;
const PUBLISHER_PROVIDED = 'io.modelcontextprotocol.registry/publisher-provided';
const POINTER_KEY = 'io.github.mchen6.countinghouse';

const check = new Ajv2020({strict: true, allErrors: true}).compile(schema);

// -> {valid, errors: [string]}. Nesting deeper than MAX_DEPTH is refused before
// anything recurses into the value.
function validateRecord(record) {
  if (!depthWithin(record, MAX_DEPTH)) return {valid: false, errors: [`nested more than ${MAX_DEPTH} levels deep`]};
  if (check(record)) return {valid: true, errors: []};
  return {
    valid: false,
    errors: check.errors.map((e) => {
      const where = e.instancePath || '(record)';
      if (e.keyword === 'additionalProperties') return `${where}: unknown field ${e.params.additionalProperty}`;
      if (e.keyword === 'required') return `${where}: missing field ${e.params.missingProperty}`;
      return `${where}: ${e.message}`;
    })
  };
}

// The record's hash, over the shared canonical serialisation (8.2).
function recordHash(record) {
  return sha256Canonical(record);
}

// Our pointer in server.json (8.3): null when absent; otherwise its three fields as
// given, however malformed (publish refuses one whose sha256 matches no record).
function pointerOf(doc) {
  const pp = doc && doc._meta && doc._meta[PUBLISHER_PROVIDED];
  if (!pp || typeof pp !== 'object' || !Object.prototype.hasOwnProperty.call(pp, POINTER_KEY)) return null;
  const p = pp[POINTER_KEY];
  const o = p && typeof p === 'object' ? p : {};
  return {record: o.record, sha256: o.sha256, recordVersion: o.recordVersion};
}

module.exports = {validateRecord, recordHash, pointerOf, MAX_DEPTH, POINTER_KEY, PUBLISHER_PROVIDED};
