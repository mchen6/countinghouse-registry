'use strict';
// server.json validation ported from the official registry (spec section 7.5).
// The upstream cases are fixtures generated from upstream's own validator tests at
// 7e8fa024 (scripts/port-upstream-fixtures.js); each case keeps the options the
// upstream test validated with and the outcome it asserts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {validateServerJson, validateWith, reduceMeta, decodeErrors, CURRENT_SCHEMA} = require('../lib/validate');
const {pointerToPath} = require('../lib/validate/schema');
const {goJsonSize} = require('../lib/go-json-size');

const UPSTREAM = path.join(__dirname, 'fixtures', 'upstream-validators');
const VALID_HERE = path.join(__dirname, 'fixtures', 'valid-here');
const PP = 'io.modelcontextprotocol.registry/publisher-provided';

const load = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))}));

function server(extra = {}) {
  return {
    $schema: CURRENT_SCHEMA, name: 'io.github.example/weather', description: 'Weather data', version: '1.0.0',
    repository: {url: 'https://github.com/example/weather', source: 'github'}, ...extra
  };
}

const errors = (r) => r.issues.filter((i) => i.severity === 'error');
const matches = (issue, want) => (!want.path || issue.path === want.path) &&
  (!want.severity || issue.severity === want.severity) && (!want.type || issue.type === want.type) &&
  (!want.reference || issue.reference === want.reference) &&
  (!want.messageContains || issue.message.includes(want.messageContains)) &&
  (!want.referenceContains || want.referenceContains.every((s) => issue.reference.includes(s)));

function checkCase(c) {
  const r = validateWith(c.input, c.opts);
  const show = () => JSON.stringify(r.issues, null, 1);
  assert.strictEqual(r.valid, c.valid, `valid should be ${c.valid}: ${show()}`);
  if (c.firstError) assert.ok(errors(r)[0].message.includes(c.firstError), `first error should contain ${JSON.stringify(c.firstError)}: ${show()}`);
  for (const ref of c.references || []) assert.ok(errors(r).some((i) => i.reference === ref), `missing reference ${ref}: ${show()}`);
  for (const want of c.hasIssues || []) assert.ok(r.issues.some((i) => matches(i, want)), `missing issue ${JSON.stringify(want)}: ${show()}`);
  if (c.issues) assert.deepStrictEqual(r.issues, c.issues);
  if (c.minIssues) assert.ok(r.issues.length >= c.minIssues, show());
  if (c.issuePathsAtLeast) {
    const found = c.issuePathsAtLeast.of.filter((p) => r.issues.some((i) => i.path === p)).length;
    assert.ok(found >= c.issuePathsAtLeast.count, `only ${found} of the paths: ${show()}`);
  }
  if (c.schemaVersionIssues !== undefined) {
    assert.strictEqual(r.issues.filter((i) => i.path === 'schema' && i.message.includes('current version')).length, c.schemaVersionIssues, show());
  }
  for (const want of c.schemaIssuesAt || []) {
    for (const i of r.issues.filter((x) => x.type === 'schema' && x.path === want.path)) assert.ok(matches(i, want), `schema issue at ${want.path}: ${show()}`);
  }
  if (c.minSchemaIssues) assert.ok(r.issues.filter((i) => i.type === 'schema').length >= c.minSchemaIssues, show());
  if (c.schemaReferencesResolved) assert.ok(r.issues.filter((i) => i.type === 'schema').every((i) => !i.reference.includes('[$ref]')), show());
}

describe('server.json validation', () => {
  describe('agrees with every upstream validator case', () => {
    for (const fixture of load(UPSTREAM)) {
      describe(fixture.source, () => {
        for (const c of fixture.cases) {
          if (c.pointer !== undefined) it(c.name, () => assert.strictEqual(pointerToPath(c.pointer), c.expected));
          else it(c.name, () => checkCase(c));
        }
      });
    }
  });

  it('every upstream test file has its fixtures (counts as ported)', () => {
    const counts = {};
    for (const f of load(UPSTREAM)) counts[f.source.split('#')[0]] = (counts[f.source.split('#')[0]] || 0) + f.cases.length;
    const at = (file) => counts[`modelcontextprotocol/registry@7e8fa024:internal/validators/${file}`];
    assert.strictEqual(at('validators_test.go'), 173);
    assert.strictEqual(at('validation_detailed_test.go'), 10);
    assert.strictEqual(at('schema_test.go'), 16);
  });

  it('refuses any $schema other than 2025-12-11 with 422-ready issue schema-version-deprecated naming the current URL', () => {
    for (const s of ['https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json', 'https://example.com/schema.json', 'not a url']) {
      const r = validateServerJson(server({$schema: s}));
      assert.strictEqual(r.valid, false, s);
      const issue = r.issues.find((i) => i.reference === 'schema-version-deprecated');
      assert.ok(issue, JSON.stringify(r.issues));
      assert.strictEqual(issue.severity, 'error');
      assert.strictEqual(issue.path, 'schema');
      assert.ok(issue.message.includes(CURRENT_SCHEMA), issue.message);
    }
    assert.strictEqual(validateServerJson(server()).valid, true, JSON.stringify(validateServerJson(server()).issues));
  });

  it('a missing $schema is schema-field-required on publish too', () => {
    const {$schema, ...doc} = server();
    assert.ok($schema);
    assert.ok(validateServerJson(doc).issues.some((i) => i.reference === 'schema-field-required'));
  });

  it('runs the full schema on publish: a description over 100 characters is refused', () => {
    const r = validateServerJson(server({description: 'x'.repeat(101)}));
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.some((i) => i.type === 'schema' && i.path === 'description'), JSON.stringify(r.issues));
  });

  it('collects schema, semantic and registry issues together', () => {
    const r = validateServerJson(server({version: '^1.0.0', description: '', packages: [{registryType: 'npm', registryBaseUrl: 'https://example.com', identifier: 'x', version: '1.0.0', transport: {type: 'stdio'}}]}));
    const types = new Set(r.issues.map((i) => i.type));
    assert.deepStrictEqual([...types].sort(), ['registry', 'schema', 'semantic'], JSON.stringify(r.issues));
  });

  it('caps publisher-provided at 4096 bytes as Go counts them', () => {
    // {"k":"<value>"} is 8 bytes of envelope around the value.
    const withValue = (v) => server({_meta: {[PP]: {k: v}}});
    assert.strictEqual(validateServerJson(withValue('x'.repeat(4088))).valid, true);
    const over = validateServerJson(withValue('x'.repeat(4089)));
    assert.strictEqual(over.valid, false);
    const issue = over.issues.find((i) => i.type === 'registry');
    assert.ok(issue.message.includes('4097'), issue.message);
    // JSON.stringify counts 4090 bytes; Go escapes each '<' as <, 5 bytes more.
    const angled = withValue(`${'x'.repeat(4079)}<<<`);
    assert.strictEqual(JSON.stringify(angled._meta[PP]).length, 4090);
    const r = validateServerJson(angled);
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.find((i) => i.type === 'registry').message.includes('4105'));
  });

  it('goJsonSize counts as encoding/json marshals', () => {
    assert.strictEqual(goJsonSize({a: '<>&'}), '{"a":"\\u003c\\u003e\\u0026"}'.length);
    assert.strictEqual(goJsonSize('\u2028\u2029'), '"\\u2028\\u2029"'.length);
    assert.strictEqual(goJsonSize('é'), 4); // two quotes and two UTF-8 bytes
    assert.strictEqual(goJsonSize('😀'), 6);
    assert.strictEqual(goJsonSize('\ud800'), 5); // a lone surrogate becomes U+FFFD, three bytes
    assert.strictEqual(goJsonSize({b: [1, 2.5, null, true], a: '"\\\n\u0001'}), JSON.stringify({b: [1, 2.5, null, true], a: '"\\\n\u0001'}).length);
  });

  it('drops _meta keys other than publisher-provided', () => {
    const doc = server({_meta: {[PP]: {a: 1}, 'com.example/other': {b: 2}}});
    assert.deepStrictEqual(reduceMeta(doc)._meta, {[PP]: {a: 1}});
    assert.deepStrictEqual(reduceMeta(server({_meta: {'com.example/other': 1}}))._meta, {});
    assert.strictEqual('_meta' in reduceMeta(server()), false);
    assert.strictEqual(doc._meta['com.example/other'].b, 2, 'the input is not changed');
  });

  it("applies upstream's base-URL allow-lists", () => {
    const pkg = (p) => server({packages: [{transport: {type: 'stdio'}, ...p}]});
    const bad = [
      {registryType: 'npm', registryBaseUrl: 'https://example.com', identifier: 'x', version: '1.0.0'},
      {registryType: 'pypi', registryBaseUrl: 'https://registry.npmjs.org', identifier: 'x', version: '1.0.0'},
      {registryType: 'oci', registryBaseUrl: 'https://docker.io', identifier: 'docker.io/a/b:1'},
      {registryType: 'oci', identifier: 'registry.example.com/a/b:1'},
      {registryType: 'mcpb', identifier: 'https://example.com/a-mcp.mcpb', fileSha256: 'a'.repeat(64)},
      {registryType: 'maven', identifier: 'x', version: '1'}
    ];
    for (const p of bad) {
      const r = validateServerJson(pkg(p));
      assert.strictEqual(r.valid, false, JSON.stringify(p));
      assert.ok(r.issues.some((i) => i.type === 'registry' && i.path === 'packages[0]'), JSON.stringify(r.issues));
    }
    assert.strictEqual(validateServerJson(pkg({registryType: 'npm', identifier: 'x', version: '1.0.0'})).valid, true);
    assert.strictEqual(validateServerJson(pkg({registryType: 'oci', identifier: 'ghcr.io/a/b:1.0.0'})).valid, true);
  });

  it('every valid-here fixture is valid', () => {
    const fixtures = load(VALID_HERE);
    assert.ok(fixtures.length >= 10);
    for (const f of fixtures) {
      const r = validateServerJson(f.document);
      assert.strictEqual(r.valid, true, `${f.file}: ${JSON.stringify(r.issues)}`);
    }
  });

  describe("where upstream depends on Go's net/url (1.26) and go-containerregistry", () => {
    const remote = (url) => validateServerJson(server({remotes: [{type: 'streamable-http', url}]}));
    const refs = (r) => r.issues.map((i) => i.reference);

    it('a bracketed host must hold an IPv6 address, wherever the bracket starts', () => {
      for (const url of ['https://a[b]/mcp', 'https://[1.2.3.4]/mcp', 'https://[not-ip]/mcp']) {
        assert.ok(refs(remote(url)).includes('invalid-remote-url'), url);
      }
      assert.strictEqual(remote('https://[2001:db8::1]/mcp').valid, true);
      assert.strictEqual(remote('https://[2001:db8::1]:8443/mcp').valid, true);
    });

    it('a port starts at the first colon of the host', () => {
      assert.ok(refs(remote('https://a.com:1:2/mcp')).includes('invalid-remote-url'));
      assert.strictEqual(remote('https://a.com:8443/mcp').valid, true);
    });

    it('a host may percent-encode only non-ASCII bytes', () => {
      assert.ok(refs(remote('https://local%68ost/mcp')).includes('invalid-remote-url'));
      assert.strictEqual(remote('https://xn--caf-dma.example/mcp').valid, true);
    });

    it('MCPB release paths are matched after unescaping', () => {
      const mcpb = (identifier) => validateServerJson(server({packages: [{registryType: 'mcpb', identifier, fileSha256: 'a'.repeat(64), transport: {type: 'stdio'}}]}));
      assert.strictEqual(mcpb('https://github.com/o/r/releases/download/v1/a-mcp.mcpb').valid, true);
      assert.ok(refs(mcpb('https://github.com/o/r/releases/download/v1/a%2Fb-mcp.mcpb')).includes('registry-mcpb-invalid-release-url'));
    });

    // go-containerregistry v0.22.1 (8a72a424fdecb4caa14f2d525e5d2503331442b5, the version
    // upstream's go.mod pins): pkg/name/ref.go ParseReference, tag.go NewTag/checkTag,
    // repository.go NewRepository/checkRepository, registry.go NewRegistry/checkRegistry,
    // digest.go NewDigest, check.go checkElement.
    it('OCI references parse as go-containerregistry v0.22.1 pkg/name does', () => {
      const oci = (identifier) => validateServerJson(server({packages: [{registryType: 'oci', identifier, transport: {type: 'stdio'}}]}));
      const ok = (id) => assert.strictEqual(oci(id).valid, true, `${id}: ${JSON.stringify(oci(id).issues)}`);
      const bad = (id, ref) => assert.ok(refs(oci(id)).includes(ref), `${id}: ${JSON.stringify(oci(id).issues)}`);
      ok('foo/bar:1'); // no '.', ':' or localhost in the first part: Docker Hub
      ok('nginx'); // the default tag, library/ namespace
      ok('ghcr.io/a/b:-x'); // tag runes [A-Za-z0-9_.-], 1-128, any first rune
      ok(`docker.io/a/b@sha256:${'a'.repeat(64)}`);
      ok(`ghcr.io/a/b:1.0@sha256:${'b'.repeat(64)}`);
      bad('localhost/foo:1', 'registry-unsupported-oci-registry'); // "localhost" is a registry
      bad('localhost:5000/foo:1', 'registry-unsupported-oci-registry');
      bad('ghcr.io/a/B:1', 'registry-invalid-oci-reference'); // repository runes are lowercase
      bad('ghcr.io/a/b:', 'registry-invalid-oci-reference'); // empty tag after the colon
      bad(`ghcr.io/a/b:${'x'.repeat(129)}`, 'registry-invalid-oci-reference');
      bad('https://ghcr.io/a/b:1', 'registry-invalid-oci-reference'); // a URL scheme
      bad('ghcr.io/a/b@sha256:abc', 'registry-invalid-oci-reference');
      bad('gh cr.io/a/b:1', 'registry-invalid-oci-reference');
      // repository.go checkRepository is checkElement(..., 1, 255) at v0.22.1; NewDigest
      // validates with opencontainers/go-digest v1.0.0, whose sha384 and sha512 are
      // available in upstream's binary (crypto/sha512 is linked through crypto/tls).
      ok('ghcr.io/a:1');
      ok(`ghcr.io/a/b@sha512:${'c'.repeat(128)}`);
      bad(`ghcr.io/a/b@md5:${'c'.repeat(32)}`, 'registry-invalid-oci-reference');
    });

    it('a parse error quotes the URL without its fragment, as Go does', () => {
      const r = validateServerJson(server({websiteUrl: 'https://a%zz/#frag'}));
      const issue = r.issues.find((i) => i.reference === 'invalid-website-url');
      assert.ok(issue, JSON.stringify(r.issues));
      assert.strictEqual(issue.message, 'invalid websiteUrl: parse "https://a%zz/": invalid URL escape "%zz"');
    });
  });

  // Upstream decodes the body into its Go structs (huma v2), which refuses any
  // property the structs do not have, before validating: probed against the
  // official POST /v0.1/validate on 2026-11-11, both answered 422 "unexpected property".
  describe('refuses unknown properties, as upstream decodes the body', () => {
    it('decodeErrors names each unexpected property as huma does', () => {
      assert.deepStrictEqual(decodeErrors(server()), []);
      const doc = server({unknownField: 1, _meta: {[PP]: {free: {form: true}}, 'com.example/other': {b: 2}},
        repository: {url: 'https://github.com/example/weather', source: 'github', branch: 'main'},
        packages: [{registryType: 'npm', identifier: 'x', version: '1.0.0', transport: {type: 'stdio', extra: 1},
          runtimeArguments: [{type: 'positional', value: 'a', bogus: true}], environmentVariables: [{name: 'A', variables: {v: {value: 'x', nope: 1}}}]}],
        icons: [{src: 'https://example.com/i.png', alt: 'x'}]});
      assert.deepStrictEqual(decodeErrors(doc).map((e) => e.location).sort(), [
        'body._meta.com.example/other', 'body.icons[0].alt', 'body.packages[0].environmentVariables[0].variables.v.nope',
        'body.packages[0].runtimeArguments[0].bogus', 'body.packages[0].transport.extra', 'body.repository.branch', 'body.unknownField'].sort());
      const top = decodeErrors(server({unknownField: 1}))[0];
      assert.strictEqual(top.message, 'unexpected property');
      assert.deepStrictEqual(top.value, server({unknownField: 1}));
    });

    it('validateServerJson refuses them, for publish and for /validate', () => {
      for (const forPublish of [true, false]) {
        const r = validateServerJson(server({unknownField: 1}), {forPublish});
        assert.strictEqual(r.valid, false);
        const i = r.issues.find((x) => x.reference === 'unexpected-property');
        assert.deepStrictEqual({type: i.type, path: i.path}, {type: 'schema', path: 'unknownField'});
      }
    });

    it('accepts every property of the Go structs', () => {
      const full = server({title: 'Weather', websiteUrl: 'https://example.com', icons: [{src: 'https://example.com/i.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light'}],
        repository: {url: 'https://github.com/example/weather', source: 'github', id: 'x', subfolder: 'a'},
        packages: [{registryType: 'npm', registryBaseUrl: 'https://registry.npmjs.org', identifier: 'x', version: '1.0.0', runtimeHint: 'npx',
          transport: {type: 'stdio'}, runtimeArguments: [{type: 'named', name: '--a', value: 'b', valueHint: 'h', isRepeated: true, description: 'd',
            isRequired: true, format: 'string', isSecret: false, default: 'c', placeholder: 'p', choices: ['b', 'c'], variables: {}}],
          packageArguments: [], environmentVariables: [{name: 'A', description: 'd', value: 'v'}]}],
        remotes: [{type: 'streamable-http', url: 'https://example.com/mcp', headers: [{name: 'X-A', value: 'v'}], variables: {}}],
        _meta: {[PP]: {anything: [1, {deep: true}]}}});
      assert.deepStrictEqual(decodeErrors(full), []);
    });
  });

  it('a document nested deeper than 64 levels is one issue, and nothing recurses into it', () => {
    let deep = {};
    for (let i = 0; i < 200000; i++) deep = {a: deep};
    for (const forPublish of [true, false]) {
      const r = validateServerJson(server({_meta: {[PP]: deep}}), {forPublish});
      assert.strictEqual(r.valid, false);
      assert.deepStrictEqual(r.issues.map((i) => i.reference), ['document-too-deep']);
    }
  });

  it('a non-object document is one schema issue, not a crash', () => {
    for (const doc of [null, [], 'x', 3]) {
      const r = validateServerJson(doc);
      assert.strictEqual(r.valid, false);
      assert.ok(r.issues.length >= 1);
    }
  });
});
