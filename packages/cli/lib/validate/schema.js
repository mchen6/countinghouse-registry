'use strict';
// Schema checks of server.json, as upstream's internal/validators/schema.go at
// 7e8fa024: the $schema version (required, known, current or by policy) and full
// JSON Schema validation against the vendored file of that version, all six files
// upstream embeds, verbatim (schemas/server.schema.<version>.json). Validation uses
// an ajv draft-07 instance (the files are draft-07); the config schema uses a
// separate 2020-12 instance. Issue paths and references read as upstream's:
// "packages[0].transport.url" and "<schema location> from: <keyword path with each
// $ref shown as [target]>".
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const CURRENT_VERSION = '2025-12-11';
const CURRENT_SCHEMA = `https://static.modelcontextprotocol.io/schemas/${CURRENT_VERSION}/server.schema.json`;
// Every version upstream embeds at the pin (internal/validators/schemas/).
const VERSIONS = ['2025-07-09', '2025-09-16', '2025-09-29', '2025-10-11', '2025-10-17', '2025-12-11'];

const ajv = new Ajv({strict: false, allErrors: true, verbose: true});
addFormats(ajv);
const schemas = new Map();
const compiled = new Map();

function schemaOf(version) {
  if (!schemas.has(version)) schemas.set(version, require(path.join(__dirname, '..', '..', 'schemas', `server.schema.${version}.json`)));
  return schemas.get(version);
}

function validatorOf(version) {
  if (!compiled.has(version)) compiled.set(version, ajv.compile(schemaOf(version)));
  return compiled.get(version);
}

const issue = (type, p, message, severity, reference) => ({type, path: p, message, severity, reference});

function versionOf(url) {
  const m = /\/schemas\/([A-Za-z0-9_~.-]+)\/server\.schema\.json/.exec(url);
  return m ? m[1] : null;
}

// upstream ConvertJSONPointerToBracketNotation: "/packages/0/url" -> "packages[0].url".
function pointerToPath(pointer) {
  if (!pointer) return '';
  const parts = pointer.replace(/^\//, '').split('/');
  let out = '';
  parts.forEach((part, i) => {
    if (/^-?\d+$/.test(part)) out += `[${part}]`;
    else out += (i > 0 ? '.' : '') + part;
  });
  return out;
}

const decode = (seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~');

// The failing keyword's location in the file and the keyword path to it from the
// root, each $ref shown as [target]: found by walking the schema along the
// instance path. ajv reports the location relative to whichever sub-schema it
// compiled, so it is matched as a suffix of the location the walk reaches.
function keywordPath(root, instancePath, schemaPath) {
  const segs = instancePath ? instancePath.slice(1).split('/').map(decode) : [];
  const suffix = schemaPath.replace(/^#/, '');
  const kw = suffix.slice(suffix.lastIndexOf('/') + 1);
  const at = (loc) => loc.replace(/^#\/?/, '').split('/').filter(Boolean).map(decode).reduce((n, k) => (n == null ? n : n[k]), root);
  const seen = new Set();
  const walk = (loc, node, rest, trail) => {
    if (!node || typeof node !== 'object') return null;
    const key = `${loc}|${rest.length}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (!rest.length && node[kw] !== undefined && `${loc}/${kw}`.endsWith(suffix)) {
      return {absolute: `${loc}/${kw}`, trail: [...trail, kw]};
    }
    if (typeof node.$ref === 'string') {
      const r = walk(node.$ref, at(node.$ref), rest, [...trail, `[${node.$ref}]`]);
      if (r) return r;
    }
    for (const comb of ['allOf', 'anyOf', 'oneOf']) {
      for (const [i, sub] of (node[comb] || []).entries()) {
        const r = walk(`${loc}/${comb}/${i}`, sub, rest, [...trail, comb, String(i)]);
        if (r) return r;
      }
    }
    for (const kw of ['if', 'then', 'else', 'not']) {
      if (node[kw]) { const r = walk(`${loc}/${kw}`, node[kw], rest, [...trail, kw]); if (r) return r; }
    }
    if (rest.length) {
      const [seg, ...more] = rest;
      if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, seg)) {
        const r = walk(`${loc}/properties/${seg}`, node.properties[seg], more, [...trail, 'properties', seg]);
        if (r) return r;
      }
      if (node.items && typeof node.items === 'object' && !Array.isArray(node.items) && /^\d+$/.test(seg)) {
        const r = walk(`${loc}/items`, node.items, more, [...trail, 'items']);
        if (r) return r;
      }
      if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        const r = walk(`${loc}/additionalProperties`, node.additionalProperties, more, [...trail, 'additionalProperties']);
        if (r) return r;
      }
    }
    return null;
  };
  return walk('#', root, segs, []);
}

function messageOf(e) {
  const show = (v) => (typeof v === 'string' ? `'${v}'` : JSON.stringify(v));
  switch (e.keyword) {
    case 'required': return `missing required fields: '${e.params.missingProperty}'`;
    case 'format': return `${show(e.data)} has invalid format '${e.params.format}'`;
    case 'enum': return `value must be one of ${e.params.allowedValues.map(show).join(', ')}`;
    case 'maxLength': return `length must be <= ${e.params.limit}, but got ${[...e.data].length}`;
    case 'minLength': return `length must be >= ${e.params.limit}, but got ${[...e.data].length}`;
    case 'pattern': return `${show(e.data)} does not match pattern ${show(e.params.pattern)}`;
    case 'type': return `expected ${e.params.type}, but got ${Array.isArray(e.data) ? 'array' : e.data === null ? 'null' : typeof e.data}`;
    case 'additionalProperties': return `additionalProperties '${e.params.additionalProperty}' not allowed`;
    default: return e.message;
  }
}

function fullValidation(doc, version) {
  const root = schemaOf(version);
  const validate = validatorOf(version);
  if (validate(doc)) return [];
  return validate.errors.map((e) => {
    const found = keywordPath(root, e.instancePath, e.schemaPath);
    const reference = found ? `${found.absolute} from: ${found.trail.join('/')}` : e.schemaPath;
    return issue('schema', pointerToPath(e.instancePath), messageOf(e), 'error', reference);
  });
}

// upstream validateServerJSONSchema. `full`: run the JSON Schema; `policy`: how a
// non-current version is reported ('error' | 'warn' | 'allow'); `currentOnly`: our
// publish rule (spec 7.5): anything but the current URL is refused, naming it, and
// no other version's schema is used.
function checkSchema(doc, {full, policy, currentOnly}) {
  const issues = [];
  const url = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.$schema : undefined;
  if (url === undefined || url === null || url === '') {
    issues.push(issue('semantic', 'schema', '$schema field is required', 'error', 'schema-field-required'));
    return issues;
  }
  if (currentOnly) {
    if (url !== CURRENT_SCHEMA) {
      const v = typeof url === 'string' ? versionOf(url) : null;
      issues.push(issue('semantic', 'schema', `schema version ${v || JSON.stringify(url)} is not the current version (${CURRENT_VERSION}). Use the current schema version: ${CURRENT_SCHEMA}`,
        'error', 'schema-version-deprecated'));
      return issues;
    }
    if (full) issues.push(...fullValidation(doc, CURRENT_VERSION));
    return issues;
  }
  const version = typeof url === 'string' ? versionOf(url) : null;
  if (!version) {
    issues.push(issue('schema', 'schema', `failed to extract schema version from URL: invalid schema URL format: ${url}`, 'error', 'schema-version-extraction-error'));
    return issues;
  }
  if (url !== CURRENT_SCHEMA) {
    if (policy === 'error') {
      issues.push(issue('semantic', 'schema', `schema version ${version} is not the current version (${CURRENT_VERSION}). Use the current schema version`, 'error', 'schema-version-deprecated'));
    } else if (policy === 'warn') {
      issues.push(issue('semantic', 'schema', `schema version ${version} is not the current version (${CURRENT_VERSION}). Consider updating to the latest schema version`, 'warning', 'schema-version-deprecated'));
    }
  }
  if (!VERSIONS.includes(version)) {
    issues.push(issue('schema', 'schema', `schema version ${version} not available: schema version ${version} not found in embedded schemas`, 'error', 'schema-version-not-available'));
    return issues;
  }
  if (full) issues.push(...fullValidation(doc, version));
  return issues;
}

module.exports = {checkSchema, pointerToPath, CURRENT_SCHEMA, CURRENT_VERSION, VERSIONS};
