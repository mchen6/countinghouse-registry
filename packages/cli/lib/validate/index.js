'use strict';
// server.json validation (spec section 7.5), in order, collecting every issue:
// 0. upstream's body decode (no property its Go structs lack), 1. schema ($schema,
// then the vendored JSON Schema), 2. upstream's semantic rules, 3. upstream's
// registry rules. Issues are upstream's shape:
// {type: 'schema'|'semantic'|'registry', path, message, severity, reference}.
//
// validateServerJson(doc) is the publish check: exactly the current $schema, the
// full schema, semantic and registry rules. With {forPublish: false} it is
// upstream's POST /v0.1/validate (ValidationAll: any version upstream embeds, a
// non-current one only warned, full schema and semantic rules, no registry rules).
// validateWith(doc, opts) takes upstream's ValidationOptions directly, for the
// ported test cases: {schema: false|'version'|'full', semantic, nonCurrentSchema:
// 'error'|'warn'|'allow', registry, currentOnly, decode}. decodeErrors(doc) gives the
// decode failures in huma's own shape, for an endpoint that answers as upstream does.
const {checkSchema, CURRENT_SCHEMA} = require('./schema');
const {semanticIssues} = require('./rules');
const {registryIssues, reduceMeta} = require('./registry-rules');
const {decodeErrors} = require('./decode');
const {depthWithin} = require('../canonical-json');

// Records, results and documents alike: nesting beyond this is refused before
// anything walks the document (canonical hashing recurses).
const MAX_DEPTH = 64;

// "body.packages[0].x" -> "packages[0].x", the path form of every other issue.
const decodeIssue = (e) => ({type: 'schema', path: e.location.replace(/^body\./, ''), message: e.message, severity: 'error', reference: 'unexpected-property'});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateWith(doc, opts = {}) {
  const issues = [];
  if (!isObject(doc)) {
    issues.push({type: 'schema', path: '', message: 'expected object', severity: 'error', reference: '#/type'});
    return {valid: false, issues};
  }
  if (!depthWithin(doc, MAX_DEPTH)) {
    issues.push({type: 'schema', path: '', message: `the document is nested more than ${MAX_DEPTH} levels deep`, severity: 'error', reference: 'document-too-deep'});
    return {valid: false, issues};
  }
  if (opts.decode) issues.push(...decodeErrors(doc).map(decodeIssue));
  if (opts.schema) {
    issues.push(...checkSchema(doc, {full: opts.schema === 'full', policy: opts.nonCurrentSchema || 'warn', currentOnly: Boolean(opts.currentOnly)}));
  }
  if (opts.semantic) issues.push(...semanticIssues(doc));
  if (opts.registry) issues.push(...registryIssues(doc));
  return {valid: !issues.some((i) => i.severity === 'error'), issues};
}

function validateServerJson(doc, {forPublish = true} = {}) {
  if (forPublish) return validateWith(doc, {decode: true, schema: 'full', currentOnly: true, semantic: true, registry: true});
  return validateWith(doc, {decode: true, schema: 'full', nonCurrentSchema: 'warn', semantic: true});
}

module.exports = {validateServerJson, validateWith, reduceMeta, decodeErrors, CURRENT_SCHEMA, MAX_DEPTH};
