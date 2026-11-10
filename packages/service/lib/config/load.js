'use strict';
// Loads and validates the service configuration (spec section 13.2). Any error
// refuses startup with the JSON pointer of the offending field.
const fs = require('fs');
const Ajv2020 = require('ajv/dist/2020');
const schema = require('./schema.json');

class ConfigError extends Error {
  constructor(field, message) {
    super(field ? `config ${field}: ${message}` : `config: ${message}`);
    this.name = 'ConfigError';
    this.field = field;
  }
}

const ajv = new Ajv2020({allErrors: false, useDefaults: true, strict: true});
const validate = ajv.compile(schema);

function pointerOf(err) {
  if (err.keyword === 'additionalProperties') return `${err.instancePath}/${err.params.additionalProperty}`;
  if (err.keyword === 'required') return `${err.instancePath}/${err.params.missingProperty}`;
  return err.instancePath;
}

function firstDuplicate(values) {
  const seen = new Set();
  for (let i = 0; i < values.length; i++) {
    if (seen.has(values[i])) return i;
    seen.add(values[i]);
  }
  return -1;
}

function crossChecks(c) {
  let i = firstDuplicate(c.claims);
  if (i >= 0) throw new ConfigError(`/claims/${i}`, 'duplicate claim');
  i = firstDuplicate(c.instances.map((x) => x.instance));
  if (i >= 0) throw new ConfigError(`/instances/${i}/instance`, 'duplicate instance id');
  i = firstDuplicate(c.publisherKeys.map((x) => x.name));
  if (i >= 0) throw new ConfigError(`/publisherKeys/${i}/name`, 'duplicate publisher key name');
  c.publisherKeys.forEach((k, ki) => {
    k.namespaces.forEach((ns, ni) => {
      if (!c.claims.includes(ns)) throw new ConfigError(`/publisherKeys/${ki}/namespaces/${ni}`, `"${ns}" is not one of the claims`);
    });
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    Object.freeze(value);
  }
  return value;
}

function loadConfig(path) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError('', `cannot read ${path} as JSON (${err.code || err.name})`);
  }
  if (!validate(config)) {
    const err = validate.errors[0];
    throw new ConfigError(pointerOf(err), err.message);
  }
  crossChecks(config);
  return deepFreeze(config);
}

module.exports = {loadConfig, ConfigError};
