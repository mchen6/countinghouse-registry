'use strict';
// server.json validation (spec section 7.5), in order, collecting every issue:
// 1. schema ($schema, then the vendored JSON Schema), 2. upstream's semantic rules,
// 3. upstream's registry rules. Issues are upstream's shape:
// {type: 'schema'|'semantic'|'registry', path, message, severity, reference}.
//
// validateServerJson(doc) is the publish check: exactly the current $schema, the
// full schema, semantic and registry rules. With {forPublish: false} it is
// upstream's POST /v0.1/validate (ValidationAll: any version upstream embeds, a
// non-current one only warned, full schema and semantic rules, no registry rules).
// validateWith(doc, opts) takes upstream's ValidationOptions directly, for the
// ported test cases: {schema: false|'version'|'full', semantic, nonCurrentSchema:
// 'error'|'warn'|'allow', registry, currentOnly}.
const {checkSchema, CURRENT_SCHEMA} = require('./schema');
const {semanticIssues} = require('./rules');
const {registryIssues, reduceMeta} = require('./registry-rules');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateWith(doc, opts = {}) {
  const issues = [];
  if (!isObject(doc)) {
    issues.push({type: 'schema', path: '', message: 'expected object', severity: 'error', reference: '#/type'});
    return {valid: false, issues};
  }
  if (opts.schema) {
    issues.push(...checkSchema(doc, {full: opts.schema === 'full', policy: opts.nonCurrentSchema || 'warn', currentOnly: Boolean(opts.currentOnly)}));
  }
  if (opts.semantic) issues.push(...semanticIssues(doc));
  if (opts.registry) issues.push(...registryIssues(doc));
  return {valid: !issues.some((i) => i.severity === 'error'), issues};
}

function validateServerJson(doc, {forPublish = true} = {}) {
  if (forPublish) return validateWith(doc, {schema: 'full', currentOnly: true, semantic: true, registry: true});
  return validateWith(doc, {schema: 'full', nonCurrentSchema: 'warn', semantic: true});
}

module.exports = {validateServerJson, validateWith, reduceMeta, CURRENT_SCHEMA};
