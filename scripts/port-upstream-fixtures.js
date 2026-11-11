#!/usr/bin/env node
'use strict';
// Regenerates packages/cli/test/fixtures/upstream-validators/ from a local clone of
// the official registry (github.com/modelcontextprotocol/registry) at the pinned
// commit, by reading the table-driven tests of internal/validators statically: no
// Go code is run. Each upstream test function becomes one fixture file; each case
// keeps upstream's input document (as Go's encoding/json marshals the struct
// literal), the validation options the test uses, and the outcome the test
// asserts. Not part of CI: run by hand when the pin moves (docs/operator.md).
//
//   node scripts/port-upstream-fixtures.js <clone dir>
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const PIN = '7e8fa024d7caeba23cfcfc62ca64b17b750fd4f7';
const OUT = path.join(__dirname, '..', 'packages', 'cli', 'test', 'fixtures', 'upstream-validators');
const CURRENT_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

// --- Go constants the tables use (pkg/model/constants.go, internal/validators/constants.go at the pin)
const CONSTS = {
  'model.CurrentSchemaURL': CURRENT_SCHEMA,
  'model.RegistryTypeNPM': 'npm', 'model.RegistryTypePyPI': 'pypi', 'model.RegistryTypeOCI': 'oci',
  'model.RegistryTypeNuGet': 'nuget', 'model.RegistryTypeMCPB': 'mcpb', 'model.RegistryTypeCargo': 'cargo',
  'model.RegistryURLCrates': 'https://crates.io', 'model.RegistryURLGitHub': 'https://github.com',
  'model.RegistryURLGitLab': 'https://gitlab.com', 'model.RegistryURLNPM': 'https://registry.npmjs.org',
  'model.RegistryURLNuGet': 'https://api.nuget.org/v3/index.json', 'model.RegistryURLPyPI': 'https://pypi.org',
  'model.RegistryURLQuay': 'https://quay.io',
  'model.TransportTypeStdio': 'stdio', 'model.TransportTypeStreamableHTTP': 'streamable-http', 'model.TransportTypeSSE': 'sse',
  'model.ArgumentTypeNamed': 'named', 'model.ArgumentTypePositional': 'positional',
  'validators.ErrInvalidRepositoryURL.Error()': 'invalid repository URL',
  'validators.ErrInvalidSubfolderPath.Error()': 'invalid subfolder path',
  'validators.ErrPackageNameHasSpaces.Error()': 'package name cannot contain spaces',
  'validators.ErrReservedVersionString.Error()': "version string 'latest' is reserved and cannot be used",
  'validators.ErrVersionLooksLikeRange.Error()': 'version must be a specific version, not a range',
  'validators.ErrInvalidRemoteURL.Error()': 'invalid remote URL',
  'validators.ErrMultipleSlashesInServerName.Error()': 'server name cannot contain multiple slashes',
  'validators.SchemaVersionPolicyAllow': 'allow', 'validators.SchemaVersionPolicyWarn': 'warn',
  'validators.SchemaVersionPolicyError': 'error',
  websiteURLInvalidCharErrSubstr: 'websiteUrl contains an invalid character',
  true: true, false: false, nil: null
};

// The rule id each asserted message belongs to (validators.go and schema.go at the pin).
const MESSAGE_RULES = [
  ['$schema field is required', 'schema-field-required'],
  ['not found in embedded schemas', 'schema-version-not-available'],
  ['version must be a specific version, not a range', 'version-looks-like-range'],
  ["version string 'latest' is reserved", 'reserved-version-string'],
  ['invalid repository URL', 'invalid-repository-url'],
  ['invalid subfolder path', 'invalid-subfolder-path'],
  ['repository url is required', 'repository-url-required'],
  ['repository source is required', 'repository-source-required'],
  ['invalid websiteUrl:', 'invalid-website-url'],
  ['websiteUrl must be absolute', 'website-url-must-be-absolute'],
  ['websiteUrl must use https scheme', 'website-url-invalid-scheme'],
  ['websiteUrl contains an invalid character', 'website-url-invalid-characters'],
  ['title cannot be only whitespace', 'title-whitespace-only'],
  ['icon src must be an absolute URL', 'icon-src-not-absolute'],
  ['icon src must use https scheme', 'icon-src-invalid-scheme'],
  ['package name cannot contain spaces', 'package-name-has-spaces'],
  ['url must be empty for stdio', 'stdio-transport-url-not-empty'],
  ['unsupported transport type for remotes', 'unsupported-remote-transport-type'],
  ['unsupported transport type:', 'unsupported-transport-type'],
  ['positional argument must provide a value or a valueHint', 'positional-argument-value-or-hint-required'],
  ["argument type must be 'positional' or 'named'", 'invalid-argument-type'],
  ['server name', 'invalid-server-name'],
  ['non-empty namespace and name parts', 'invalid-server-name']
];

// --- Go tokenizer and composite-literal parser (only what the test tables use)
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const simple = {n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\'};
          if (e in simple) { s += simple[e]; j += 2; } else if (e === 'u') { s += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; } else if (e === 'x') { s += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; } else throw new Error(`escape \\${e}`);
        } else s += src[j++];
      }
      toks.push({t: 'str', v: s});
      i = j + 1;
      continue;
    }
    if (c === '`') { const j = src.indexOf('`', i + 1); toks.push({t: 'str', v: src.slice(i + 1, j)}); i = j + 1; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 200));
    if (id) { toks.push({t: 'id', v: id[0]}); i += id[0].length; continue; }
    const num = /^[0-9]+/.exec(src.slice(i, i + 40));
    if (num) { toks.push({t: 'num', v: Number(num[0])}); i += num[0].length; continue; }
    if (src.startsWith(':=', i)) { toks.push({t: 'p', v: ':='}); i += 2; continue; }
    toks.push({t: 'p', v: c});
    i++;
  }
  return toks;
}

class Parser {
  constructor(toks, pos = 0) { this.toks = toks; this.pos = pos; }
  peek(k = 0) { return this.toks[this.pos + k]; }
  is(v, k = 0) { const t = this.peek(k); return t && t.t === 'p' && t.v === v; }
  eat(v) { if (!this.is(v)) throw new Error(`expected ${v} at token ${this.pos}: ${JSON.stringify(this.peek())}`); this.pos++; }
  ident() { const t = this.toks[this.pos++]; if (t.t !== 'id') throw new Error(`ident at ${this.pos}: ${JSON.stringify(t)}`); return t.v; }
  qualified() { let n = this.ident(); while (this.is('.') && this.peek(1).t === 'id') { this.pos++; n += `.${this.ident()}`; } return n; }
  type() {
    if (this.is('*')) { this.pos++; return this.type(); }
    if (this.is('[')) { this.eat('['); this.eat(']'); return {slice: this.type()}; }
    if (this.peek().t === 'id' && this.peek().v === 'map') { this.pos++; this.eat('['); const k = this.type(); this.eat(']'); return {map: this.type(), key: k}; }
    if (this.peek().t === 'id' && this.peek().v === 'struct') {
      this.pos++; this.eat('{');
      const fields = [];
      while (!this.is('}')) { const name = this.ident(); fields.push({name, type: this.type()}); }
      this.eat('}');
      return {struct: fields};
    }
    return this.qualified();
  }
  // A literal value of the given type (the type may be elided in the source).
  value(type) {
    if (this.is('&')) { this.pos++; return this.value(type); }
    const t = this.peek();
    if (t.t === 'str') {
      this.pos++;
      let s = t.v;
      while (this.is('+')) { this.pos++; s += this.value('string'); }
      return s;
    }
    if (t.t === 'num') { this.pos++; return t.v; }
    if (this.is('{')) return this.composite(type);
    if (this.is('[') || (t.t === 'id' && (t.v === 'map' || t.v === 'struct'))) { const ty = this.type(); return this.composite(ty); }
    const name = this.qualified();
    if (this.is('{')) return this.composite(name);
    if (this.is('(')) {
      this.eat('(');
      if (this.is(')')) { this.eat(')'); return lookup(`${name}()`); }
      if (name === 'stringPtr') { const v = this.value('string'); this.eat(')'); return v; }
      if (name === 'strings.Repeat') { const s = this.value('string'); this.eat(','); const n = this.value('int'); this.eat(')'); return s.repeat(n); }
      throw new Error(`call ${name}`);
    }
    return lookup(name);
  }
  composite(type) {
    this.eat('{');
    // A type is a qualified name (string) or {slice}, {map, key} or {struct}.
    const isSlice = typeof type === 'object' && type !== null && 'slice' in type;
    const isMap = typeof type === 'object' && type !== null && 'map' in type;
    const out = isSlice ? [] : isMap ? {} : {__type: type, fields: {}};
    let index = 0;
    while (!this.is('}')) {
      if (isSlice) out.push(this.value(type.slice));
      else if (isMap) { const k = this.value(type.key); this.eat(':'); out[k] = this.value(type.map); } else if (this.peek().t === 'id' && this.is(':', 1)) {
        const key = this.ident(); this.eat(':');
        out.fields[key] = this.value(fieldType(type, key));
      } else {
        const f = type.struct[index++];
        out.fields[f.name] = this.value(f.type);
      }
      if (this.is(',')) this.pos++;
    }
    this.eat('}');
    return out;
  }
}

function lookup(name) {
  if (!(name in CONSTS)) throw new Error(`unknown constant ${name}`);
  return CONSTS[name];
}

// --- Go struct types: field name -> [json key, omitempty, type] (pkg/model/types.go, pkg/api/v0/types.go)
const TYPES = {
  'apiv0.ServerJSON': {Schema: ['$schema', false, 'string'], Name: ['name', false, 'string'], Description: ['description', false, 'string'],
    Title: ['title', true, 'string'], Repository: ['repository', true, 'model.Repository'], Version: ['version', false, 'string'],
    WebsiteURL: ['websiteUrl', true, 'string'], Icons: ['icons', true, {slice: 'model.Icon'}], Packages: ['packages', true, {slice: 'model.Package'}],
    Remotes: ['remotes', true, {slice: 'model.Transport'}], Meta: ['_meta', true, 'apiv0.ServerMeta']},
  'apiv0.ServerMeta': {PublisherProvided: ['io.modelcontextprotocol.registry/publisher-provided', true, {map: 'any', key: 'string'}]},
  'model.Repository': {URL: ['url', true, 'string'], Source: ['source', true, 'string'], ID: ['id', true, 'string'], Subfolder: ['subfolder', true, 'string']},
  'model.Package': {RegistryType: ['registryType', false, 'string'], RegistryBaseURL: ['registryBaseUrl', true, 'string'], Identifier: ['identifier', false, 'string'],
    Version: ['version', true, 'string'], FileSHA256: ['fileSha256', true, 'string'], RunTimeHint: ['runtimeHint', true, 'string'],
    Transport: ['transport', false, 'model.Transport'], RuntimeArguments: ['runtimeArguments', true, {slice: 'model.Argument'}],
    PackageArguments: ['packageArguments', true, {slice: 'model.Argument'}], EnvironmentVariables: ['environmentVariables', true, {slice: 'model.KeyValueInput'}]},
  'model.Transport': {Type: ['type', false, 'string'], URL: ['url', true, 'string'], Headers: ['headers', true, {slice: 'model.KeyValueInput'}],
    Variables: ['variables', true, {map: 'model.Input', key: 'string'}]},
  'model.Input': {Description: ['description', true, 'string'], IsRequired: ['isRequired', true, 'bool'], Format: ['format', true, 'string'],
    Value: ['value', true, 'string'], IsSecret: ['isSecret', true, 'bool'], Default: ['default', true, 'string'], Placeholder: ['placeholder', true, 'string'],
    Choices: ['choices', true, {slice: 'string'}]},
  'model.InputWithVariables': {Input: [null, false, 'model.Input'], Variables: ['variables', true, {map: 'model.Input', key: 'string'}]},
  'model.KeyValueInput': {InputWithVariables: [null, false, 'model.InputWithVariables'], Name: ['name', false, 'string']},
  // Argument's MarshalJSON omits empty value/valueHint unless decoded present; a Go
  // literal never sets "present", so both are plain omitempty here.
  'model.Argument': {InputWithVariables: [null, false, 'model.InputWithVariables'], Type: ['type', false, 'string'], Name: ['name', true, 'string'],
    ValueHint: ['valueHint', true, 'string'], IsRepeated: ['isRepeated', true, 'bool']},
  'model.Icon': {Src: ['src', false, 'string'], MimeType: ['mimeType', true, 'string'], Sizes: ['sizes', true, {slice: 'string'}], Theme: ['theme', true, 'string']}
};

function fieldType(type, key) {
  if (typeof type === 'object' && type !== null && type.struct) return type.struct.find((f) => f.name === key).type;
  const t = TYPES[type];
  if (!t || !t[key]) throw new Error(`field ${key} of ${JSON.stringify(type)}`);
  return t[key][2];
}

const isEmpty = (v) => v === undefined || v === null || v === '' || v === false || v === 0 ||
  (Array.isArray(v) && v.length === 0) || (v && v.constructor === Object && !v.__type && Object.keys(v).length === 0);

// encoding/json's view of a value of a Go type.
function toJSON(v, type) {
  if (typeof type === 'object' && 'slice' in type) return v === null || v === undefined ? null : v.map((x) => toJSON(x, type.slice));
  if (typeof type === 'object' && 'map' in type) {
    if (v === null || v === undefined) return null;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, type.map === 'any' ? x : toJSON(x, type.map)]));
  }
  const t = TYPES[type];
  if (!t) return v === undefined ? zero(type) : v;
  if (v === null) return null;
  const fields = (v && v.fields) || {};
  const out = {};
  for (const [goName, [key, omit, ft]] of Object.entries(t)) {
    let fv = fields[goName];
    if (key === null) { Object.assign(out, toJSON(fv || {fields: {}}, ft)); continue; } // embedded struct
    if (fv === undefined && omit) continue; // unset: zero value, or a nil pointer
    if (fv === undefined) fv = TYPES[ft] ? {fields: {}} : zero(ft);
    // omitempty drops "", false, 0, nil and empty slices and maps; never a struct value.
    if (omit && isEmpty(fv)) continue;
    out[key] = toJSON(fv, ft);
  }
  return out;
}

function zero(type) {
  if (type === 'string') return '';
  if (type === 'bool') return false;
  if (type === 'int') return 0;
  return null;
}

// --- reading the tests
function testBody(src, name) {
  const start = src.indexOf(`func ${name}(t *testing.T) {`);
  if (start < 0) throw new Error(`no test ${name}`);
  const next = src.indexOf('\nfunc ', start + 10);
  return src.slice(start, next < 0 ? src.length : next);
}

// The literal assigned to `<varName> :=` (or the first `:=` table) in a test body.
function table(body, varName) {
  const toks = tokenize(body);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t === 'id' && toks[i].v === varName && toks[i + 1].v === ':=') {
      const p = new Parser(toks, i + 2);
      const type = p.type();
      return {type, value: p.composite(type)};
    }
  }
  throw new Error(`no table ${varName}`);
}

const SEMANTIC = {schema: 'version', semantic: true, nonCurrentSchema: 'warn'}; // ValidationSchemaVersionAndSemantic
const ALL = {schema: 'full', semantic: true, nonCurrentSchema: 'warn'}; // ValidationAll

function refsFor(message, input) {
  if (!message) return [];
  if (message.includes('template variables in URL')) return ['invalid-templated-url'];
  if (message.startsWith('url is required for ')) {
    // Packages are validated before remotes: the first such issue names a package
    // transport when one lacks its url.
    const pkgMissing = (input.packages || []).some((p) => p.transport && ['streamable-http', 'sse'].includes(p.transport.type) && !p.transport.url);
    return [pkgMissing ? 'streamable-transport-url-required' : 'remote-transport-url-required'];
  }
  if (message.startsWith('invalid remote URL')) {
    // Shared by invalid-remote-url and invalid-templated-url: decided only when
    // the remote URL has no template, so the templated check cannot fire.
    const urls = (input.remotes || []).map((r) => r.url || '');
    return urls.some((u) => /\{[^}]+\}/.test(u)) ? [] : ['invalid-remote-url'];
  }
  const hit = MESSAGE_RULES.find(([m]) => message.includes(m) || m.includes(message));
  if (!hit) throw new Error(`no rule for message ${JSON.stringify(message)}`);
  return [hit[1]];
}

function semanticCase(name, input, errorText, expectError = Boolean(errorText)) {
  const c = {name, opts: SEMANTIC, input, valid: !expectError};
  if (errorText) { c.firstError = errorText; c.references = refsFor(errorText, input); }
  return c;
}

const argServer = (arg) => toJSON({fields: {
  Schema: CURRENT_SCHEMA, Name: 'com.example/test-server', Description: 'A test server',
  Repository: {fields: {URL: 'https://github.com/owner/repo', Source: 'github', ID: 'owner/repo'}}, Version: '1.0.0',
  Packages: [{fields: {Identifier: 'test-package', RegistryType: 'npm', RegistryBaseURL: 'https://registry.npmjs.org',
    Transport: {fields: {Type: 'stdio'}}, RuntimeArguments: [arg]}}],
  Remotes: [{fields: {Type: 'streamable-http', URL: 'https://example.com/remote'}}]
}}, 'apiv0.ServerJSON');

const field = (row, k) => row.fields[k];

const VALIDATORS_TESTS = {
  TestValidate: (b) => table(b, 'tests').value.map((r) => semanticCase(field(r, 'name'), toJSON(field(r, 'serverDetail'), 'apiv0.ServerJSON'), field(r, 'expectedError'))),
  TestValidate_RemoteNamespaceMatch: (b) => table(b, 'tests').value.map((r) => semanticCase(field(r, 'name'), toJSON(field(r, 'serverDetail'), 'apiv0.ServerJSON'), field(r, 'errorMsg'), field(r, 'expectError'))),
  TestValidate_ServerNameFormat: (b) => table(b, 'tests').value.map((r) => semanticCase(field(r, 'name'), toJSON(field(r, 'serverDetail'), 'apiv0.ServerJSON'), field(r, 'errorMsg'), field(r, 'expectError'))),
  TestValidate_MultipleSlashesInServerName: (b) => table(b, 'tests').value.map((r) => semanticCase(field(r, 'name'),
    toJSON({fields: {Schema: CURRENT_SCHEMA, Name: field(r, 'serverName')}}, 'apiv0.ServerJSON'), field(r, 'errorMsg'), field(r, 'expectError'))),
  TestValidateArgument_ValidNamedArguments: (b) => table(b, 'validCases').value.map((a) => semanticCase(`Valid_${a.fields.Name}`, argServer(a), '')),
  TestValidateArgument_ValidPositionalArguments: (b) => table(b, 'positionalCases').value.map((a, i) => semanticCase(`ValidPositional_${i}`, argServer(a), '')),
  TestValidateArgument_InvalidNamedArgumentNames: (b) => table(b, 'invalidNameCases').value.map((r) => ({...semanticCase(`Invalid_${field(r, 'name')}`, argServer(field(r, 'arg')), '', true),
    references: [field(r, 'arg').fields.Name ? 'invalid-named-argument-name' : 'named-argument-name-required']})),
  TestValidateArgument_InvalidValueFields: (b) => table(b, 'invalidValueCases').value.map((r) => {
    const arg = field(r, 'arg');
    const fv = (k) => ((arg.fields.InputWithVariables || {fields: {}}).fields.Input || {fields: {}}).fields[k];
    const name = arg.fields.Name || '';
    const refs = [];
    if (fv('Value') && fv('Value').startsWith(name)) refs.push('argument-value-starts-with-name');
    if (fv('Default') && fv('Default').startsWith(name)) refs.push('argument-default-starts-with-name');
    return {...semanticCase(`Invalid_${field(r, 'name')}`, argServer(arg), '', true), references: refs};
  }),
  TestValidateArgument_ValidValueFields: (b) => table(b, 'validValueCases').value.map((r) => semanticCase(`Valid_${field(r, 'name')}`, argServer(field(r, 'arg')), '')),
  TestValidateArgument_InvalidArgumentType: (b) => table(b, 'invalidTypeCases').value.map((r) => semanticCase(`Invalid_${field(r, 'name')}`, argServer(field(r, 'arg')), "argument type must be 'positional' or 'named'")),
  TestValidateArgument_PositionalValueOrHint: (b) => table(b, 'positionalCases').value.map((r) => semanticCase(field(r, 'name'), argServer(field(r, 'arg')),
    field(r, 'expectError') ? 'positional argument must provide a value or a valueHint' : '')),
  TestValidate_TransportValidation: (b) => table(b, 'tests').value.map((r) => semanticCase(field(r, 'name'), toJSON(field(r, 'serverDetail'), 'apiv0.ServerJSON'), field(r, 'expectedError'))),
  TestValidate_RegistryTypesAndUrls: (b) => table(b, 'testCases').value.map((r) => ({
    name: field(r, 'tcName'),
    opts: {registry: true},
    input: toJSON({fields: {Schema: CURRENT_SCHEMA, Name: field(r, 'name'), Description: 'A test server',
      Repository: {fields: {URL: 'https://github.com/owner/repo', Source: 'github', ID: 'owner/repo'}}, Version: '1.0.0',
      Packages: [{fields: {Identifier: field(r, 'identifier'), RegistryType: field(r, 'registryType'), RegistryBaseURL: field(r, 'baseURL'),
        Version: field(r, 'version'), FileSHA256: field(r, 'fileSHA256'), Transport: {fields: {Type: 'stdio'}}}}]}}, 'apiv0.ServerJSON'),
    valid: !field(r, 'expectError'),
    // Upstream also fetches the package to check ownership; the valid cases
    // name real packages that pass it. Version 1 has no ownership check (spec 7.5).
    note: field(r, 'expectError') ? undefined : 'upstream also checks package ownership over the network; not ported (spec 7.5)'
  })),
  TestValidateTitle: (b) => table(b, 'tests').value.map((r) => semanticCase(field(r, 'name'), toJSON(field(r, 'serverDetail'), 'apiv0.ServerJSON'), field(r, 'expectedError')))
};

// The detailed tests validate one document each and assert on the issues.
function detailedDoc(body) {
  const toks = tokenize(body);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].v === 'serverJSON' && toks[i + 1].v === ':=') {
      const p = new Parser(toks, i + 2);
      return toJSON(p.value(null), 'apiv0.ServerJSON');
    }
  }
  throw new Error('no serverJSON');
}

const DETAILED_TESTS = {
  TestValidateServerJSON_CollectsAllErrors: (b) => [{name: 'collects all errors', opts: SEMANTIC, input: detailedDoc(b), valid: false,
    minIssues: 6, issuePathsAtLeast: {count: 6, of: ['name', 'version', 'repository.url', 'websiteUrl', 'packages[0].identifier', 'packages[0].version',
      'packages[0].transport.url', 'packages[0].runtimeArguments[0].name', 'remotes[0].type', 'remotes[0].url']}}],
  TestValidateServerJSON_ValidServer: (b) => [{name: 'valid server', opts: SEMANTIC, input: detailedDoc(b), valid: true, issues: []}],
  TestValidateServerJSON_ContextPaths: (b) => [{name: 'context paths', opts: SEMANTIC, input: detailedDoc(b), valid: false,
    hasIssues: [{path: 'packages[0].version'}, {path: 'packages[1].runtimeArguments[0].name'},
      {path: 'packages[1].runtimeArguments[1].type', reference: 'invalid-argument-type'},
      {path: 'packages[1].runtimeArguments[2]', reference: 'positional-argument-value-or-hint-required'}]}],
  // Upstream asserts issues at both paths (any type), and checks the reference of a
  // schema issue at each path only if there is one.
  TestValidateServerJSON_RefResolution: (b) => [{name: 'ref resolution', opts: ALL, input: detailedDoc(b), valid: false,
    hasIssues: [{path: 'repository.url'}, {path: 'packages[0].packageArguments[0].format'}],
    schemaIssuesAt: [{path: 'repository.url',
      reference: '#/definitions/Repository/properties/url/format from: [#/definitions/ServerDetail]/properties/repository/[#/definitions/Repository]/properties/url/format'},
    {path: 'packages[0].packageArguments[0].format',
      referenceContains: ['#/definitions/Input/properties/format/enum', '[#/definitions/InputWithVariables]', '[#/definitions/Input]']}],
    minSchemaIssues: 1, schemaReferencesResolved: true}],
  TestValidateServerJSON_EmptySchema: (b) => [{name: 'empty schema', opts: ALL, input: detailedDoc(b), valid: false,
    hasIssues: [{path: 'schema', severity: 'error', messageContains: '$schema field is required', reference: 'schema-field-required'}]}],
  TestValidateServerJSON_NonCurrentSchema_Warning: (b) => [{name: 'non-current schema warns', opts: ALL, input: detailedDoc(b), valid: true,
    hasIssues: [{path: 'schema', severity: 'warning', messageContains: 'not the current version', reference: 'schema-version-deprecated'}]}],
  TestValidateServerJSON_InvalidSchema_Error: (b) => [{name: 'unknown schema version', opts: ALL, input: detailedDoc(b), valid: false,
    hasIssues: [{path: 'schema', severity: 'error', messageContains: 'not available', reference: 'schema-version-not-available'}]}],
  TestValidateServerJSON_NonCurrentSchema_Policies: (b) => {
    const input = detailedDoc(b);
    return table(b, 'tests').value.map((r) => {
      const policy = field(r, 'policy');
      const c = {name: field(r, 'name'), opts: {schema: 'full', semantic: true, nonCurrentSchema: policy}, input, valid: field(r, 'expectValid'),
        schemaVersionIssues: field(r, 'expectIssueCount')};
      if (field(r, 'expectWarning')) c.hasIssues = [{path: 'schema', severity: 'warning', messageContains: 'not the current version'}];
      if (field(r, 'expectError')) c.hasIssues = [{path: 'schema', severity: 'error', messageContains: 'not the current version'}];
      return c;
    });
  }
};

const SCHEMA_TESTS = {
  TestConvertJSONPointerToBracketNotation: (b) => table(b, 'tests').value.map((r) => ({name: field(r, 'name'), pointer: field(r, 'jsonPointer'), expected: field(r, 'expectedOutput')}))
};

function main() {
  const clone = process.argv[2];
  if (!clone) { console.error('usage: port-upstream-fixtures.js <clone dir>'); process.exit(2); }
  const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  if (head !== PIN) { console.error(`clone is at ${head}, expected ${PIN}`); process.exit(1); }
  fs.mkdirSync(OUT, {recursive: true});
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.json')) fs.rmSync(path.join(OUT, f));
  const groups = [['validators_test.go', VALIDATORS_TESTS], ['validation_detailed_test.go', DETAILED_TESTS], ['schema_test.go', SCHEMA_TESTS]];
  const counts = {};
  for (const [file, tests] of groups) {
    const src = fs.readFileSync(path.join(clone, 'internal', 'validators', file), 'utf8');
    const declared = [...src.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map((m) => m[1]);
    const missing = declared.filter((n) => !tests[n]);
    if (missing.length) throw new Error(`${file}: tests not ported: ${missing.join(', ')}`);
    counts[file] = 0;
    for (const [name, build] of Object.entries(tests)) {
      const cases = build(testBody(src, name));
      counts[file] += cases.length;
      const doc = {source: `modelcontextprotocol/registry@${PIN.slice(0, 8)}:internal/validators/${file}#${name}`, cases};
      fs.writeFileSync(path.join(OUT, `${file.replace(/\.go$/, '')}.${name}.json`), `${JSON.stringify(doc, null, 2)  }\n`);
    }
  }
  for (const [file, n] of Object.entries(counts)) console.log(`${file}: ${n} cases`);
}

if (require.main === module) main();
module.exports = {tokenize, Parser, toJSON};
