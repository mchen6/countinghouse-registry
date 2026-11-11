'use strict';
// register <dir> (the reviewer's message of 2026-11-10): a customer with no
// registry of their own hands over a directory; every server.json in it is
// published into a claimed namespace with one exchange.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {register, findServerJsons} = require('../lib/commands/register');
const {generate} = require('../lib/commands/generate');
const {main} = require('../bin/countinghouse-registry-cli');
const {CURRENT_SCHEMA} = require('../lib/validate');
const {moduleCopy, validateOk, fixtureTools} = require('./support/module');
const {startService} = require('./support/service');

const doc = (name, version = '1.0.0') => ({
  $schema: CURRENT_SCHEMA, name, description: `The ${name} server`, version,
  remotes: [{type: 'streamable-http', url: 'https://mcp.example.com/mcp'}]
});

function io() {
  const chunks = [];
  const w = {write: (s) => { chunks.push(String(s)); return true; }};
  return {stdout: w, stderr: w, env: {}, text: () => chunks.join('')};
}

describe('register', () => {
  let svc;
  let dir;
  beforeEach(async () => {
    svc = await startService();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-register-'));
  });
  afterEach(async () => { fs.rmSync(dir, {recursive: true, force: true}); await svc.close(); });

  const put = (rel, value) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  const served = async (name) => (await svc.get(`/v0.1/servers/${encodeURIComponent(name)}/versions/1.0.0`)).status;
  const opts = () => ({dir, registry: svc.url, domain: svc.domain, keyFile: svc.keyFile});

  it('publishes every server.json in the directory, one line per file', async () => {
    put('alpha/server.json', doc('com.example/alpha'));
    put('beta/server.json', doc('com.example/beta'));
    put('beta/nested/gamma/server.json', doc('com.example/gamma'));
    put('beta/README.md', 'not a server');
    put('node_modules/dep/server.json', doc('com.example/skipped'));
    const exchanges = [];
    const spyFetch = (url, init) => { if (String(url).includes('/auth/')) exchanges.push(url); return fetch(url, init); };
    const out = await register({...opts(), fetch: spyFetch});
    assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome, r.status]), [
      ['alpha/server.json', 'published', 200], ['beta/nested/gamma/server.json', 'published', 200], ['beta/server.json', 'published', 200]
    ]);
    assert.strictEqual(exchanges.length, 1);
    for (const n of ['alpha', 'beta', 'gamma']) assert.strictEqual(await served(`com.example/${n}`), 200);
    assert.strictEqual(await served('com.example/skipped'), 404);

    // Run again with one new file: what is already published is skipped (exit 0).
    put('delta/server.json', doc('com.example/delta'));
    const cli = io();
    assert.strictEqual(await main(['register', dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], cli), 0, cli.text());
    const lines = cli.text().trim().split('\n');
    assert.deepStrictEqual(lines, [
      'skip alpha/server.json com.example/alpha@1.0.0: already published here',
      'skip beta/nested/gamma/server.json com.example/gamma@1.0.0: already published here',
      'skip beta/server.json com.example/beta@1.0.0: already published here',
      'ok   delta/server.json com.example/delta@1.0.0',
      '1 published, 3 skipped, 0 failed'
    ]);
  });

  it('a different document under a version already published here fails; an identical one is skipped', async () => {
    put('a/server.json', doc('com.example/srv-a'));
    put('b/server.json', doc('com.example/srv-b'));
    await register(opts());
    put('b/server.json', {...doc('com.example/srv-b'), description: 'Changed after publishing'});
    const out = await register(opts());
    assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome, r.status]), [['a/server.json', 'skipped', 409], ['b/server.json', 'failed', 409]]);
    assert.match(out.results[1].detail, /a different document is already published as com\.example\/srv-b@1\.0\.0; published versions are immutable: publish a new version/);
  });

  it('a file the registry refuses as invalid fails with its path and every validation issue; the rest publish', async () => {
    put('a/server.json', {...doc('com.example/srv-a'), description: 'x'.repeat(101), websiteUrl: 'http://insecure.example'});
    put('b/server.json', doc('com.example/srv-b'));
    const cli = io();
    assert.strictEqual(await main(['register', dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], cli), 1);
    const text = cli.text();
    assert.match(text, /^FAIL a\/server\.json com\.example\/srv-a@1\.0\.0: 422 Unprocessable Entity: /m);
    assert.match(text, /^ {5}description: /m);
    assert.match(text, /^ {5}websiteUrl: websiteUrl must use https scheme/m);
    assert.match(text, /^ok   b\/server\.json com\.example\/srv-b@1\.0\.0$/m);
    assert.match(text, /^1 published, 0 skipped, 1 failed$/m);
    const out = await register(opts());
    assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome]), [['a/server.json', 'failed'], ['b/server.json', 'skipped']]);
    assert.ok(out.results[0].issues.some((l) => l.startsWith('websiteUrl: ')), out.results[0].issues.join('\n'));
  });

  it('a name outside the claims fails that file with 403 and the others still publish (exit 1)', async () => {
    put('a/server.json', doc('com.example/srv-a'));
    put('b/server.json', doc('org.other/srv-b'));
    put('c/server.json', doc('com.example/srv-c'));
    const out = await register(opts());
    assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome, r.status]), [['a/server.json', 'published', 200], ['b/server.json', 'failed', 403], ['c/server.json', 'published', 200]]);
    assert.match(out.results[1].detail, /403 Forbidden: /);
    assert.strictEqual(await served('com.example/srv-c'), 200);
    assert.strictEqual(await served('org.other/srv-b'), 404);
  });

  it('a file that is not JSON fails on its own, without a request', async () => {
    put('a/server.json', '{not json');
    put('b/server.json', doc('com.example/srv-b'));
    const out = await register(opts());
    assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome, r.status]), [['a/server.json', 'failed', null], ['b/server.json', 'published', 200]]);
    assert.match(out.results[0].detail, /not valid JSON/);
  });

  it('a module directory with a pointer has its record PUT first', async () => {
    const m = moduleCopy();
    try {
      await generate({dir: m.dir, registry: svc.url, exec: validateOk().exec, toolsList: fixtureTools});
      put('echo/server.json', fs.readFileSync(path.join(m.dir, 'server.json'), 'utf8'));
      put('echo/countinghouse-record.json', fs.readFileSync(path.join(m.dir, 'countinghouse-record.json'), 'utf8'));
      const out = await register(opts());
      assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome, r.status]), [['echo/server.json', 'published', 200]]);
      assert.strictEqual((await svc.get(`/v0.1/x/io.github.mchen6/countinghouse-registry/records/${encodeURIComponent('com.example/echo')}/versions/1.0.0`)).status, 200);
    } finally {
      m.remove();
    }
  });

  it('a symlinked server.json is published with the record beside the file it points to', async () => {
    const m = moduleCopy();
    try {
      await generate({dir: m.dir, registry: svc.url, exec: validateOk().exec, toolsList: fixtureTools});
      fs.mkdirSync(path.join(dir, 'echo'));
      fs.symlinkSync(path.join(m.dir, 'server.json'), path.join(dir, 'echo', 'server.json'));
      const out = await register(opts());
      assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome, r.status, r.detail]), [['echo/server.json', 'published', 200, 'published']]);
      assert.strictEqual((await svc.get(`/v0.1/x/io.github.mchen6/countinghouse-registry/records/${encodeURIComponent('com.example/echo')}/versions/1.0.0`)).status, 200);
    } finally {
      m.remove();
    }
  });

  it('a token that expires during the run is renewed once and the file still publishes', async () => {
    put('a/server.json', doc('com.example/srv-a'));
    put('b/server.json', doc('com.example/srv-b'));
    const exchanges = [];
    let spoiled = false;
    // The second publish arrives with a token the registry no longer accepts.
    const spyFetch = (url, init) => {
      if (String(url).endsWith('/auth/dns')) exchanges.push(url);
      if (String(url).endsWith('/v0.1/publish') && init.body.includes('srv-b') && !spoiled) {
        spoiled = true;
        return fetch(url, {...init, headers: {...init.headers, authorization: 'Bearer expired.token.value'}});
      }
      return fetch(url, init);
    };
    const out = await register({...opts(), fetch: spyFetch});
    assert.deepStrictEqual(out.results.map((r) => [r.file, r.outcome]), [['a/server.json', 'published'], ['b/server.json', 'published']]);
    assert.strictEqual(exchanges.length, 2);
  });

  it('a registry that stops answering ends the run with exit 2, naming the files not tried', async () => {
    put('a/server.json', doc('com.example/srv-a'));
    put('b/server.json', doc('com.example/srv-b'));
    const downFetch = (url, init) => (String(url).endsWith('/auth/dns') ? fetch(url, init) : Promise.reject(Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}})));
    const cli = io();
    assert.strictEqual(await main(['register', dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], {...cli, fetch: downFetch}), 2);
    assert.match(cli.text(), /could not be reached \(ECONNREFUSED\)\ninterrupted: a\/server\.json \(it may be partly stored: run register again\)\nnot tried: b\/server\.json\n$/);
  });

  it('a connection reset while the second file\'s answer is read ends the run with exit 2: that file interrupted, the rest not tried', async () => {
    put('a/server.json', doc('com.example/srv-a'));
    put('b/server.json', doc('com.example/srv-b'));
    put('c/server.json', doc('com.example/srv-c'));
    const resetFetch = async (url, init) => {
      const res = await fetch(url, init);
      if (String(url).endsWith('/v0.1/publish') && init.body.includes('srv-b')) {
        return {status: res.status, text: () => Promise.reject(Object.assign(new TypeError('terminated'), {cause: {code: 'ECONNRESET'}}))};
      }
      return res;
    };
    const cli = io();
    assert.strictEqual(await main(['register', dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], {...cli, fetch: resetFetch}), 2);
    const text = cli.text();
    assert.match(text, /^ok   a\/server\.json com\.example\/srv-a@1\.0\.0\n/);
    assert.match(text, /could not be reached \(ECONNRESET\)\ninterrupted: b\/server\.json \(it may be partly stored: run register again\)\nnot tried: c\/server\.json\n$/);
    assert.ok(!text.includes('unexpected error'), text);
  });

  it('a file with a name and no version prints the name alone', async () => {
    const {version, ...noVersion} = doc('com.example/srv-a');
    put('a/server.json', noVersion);
    const cli = io();
    assert.strictEqual(await main(['register', dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], cli), 1);
    assert.match(cli.text(), /^FAIL a\/server\.json com\.example\/srv-a: /m);
    assert.ok(!cli.text().includes('@undefined'), cli.text());
  });

  it('a 409 whose comparison read fails says so, rather than calling the document different', async () => {
    put('a/server.json', doc('com.example/srv-a'));
    await register(opts());
    const noGet = (url, init) => (init.method === 'GET' ? Promise.resolve(new Response(JSON.stringify({title: 'Internal Server Error', status: 500, detail: 'boom'}), {status: 500})) : fetch(url, init));
    const out = await register({...opts(), fetch: noGet});
    assert.strictEqual(out.results[0].outcome, 'failed');
    assert.match(out.results[0].detail, /^409 Conflict: .*; comparing with the published version failed: GET .*: 500 Internal Server Error: boom$/);
  });

  it('an empty directory is exit 1 with "no server.json found"', async () => {
    await assert.rejects(register(opts()), (err) => {
      assert.strictEqual(err.exitCode, 1);
      assert.match(err.message, /no server\.json found in /);
      return true;
    });
    const cli = io();
    assert.strictEqual(await main(['register', dir, '--registry', svc.url, '--domain', svc.domain, '--key', svc.keyFile], cli), 1);
    assert.match(cli.text(), /no server\.json found/);
  });
});

describe('findServerJsons', () => {
  let dir;
  let outside;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-find-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-outside-'));
  });
  afterEach(() => { for (const d of [dir, outside]) fs.rmSync(d, {recursive: true, force: true}); });

  it('follows a symlinked server.json and a symlinked directory, once each, without looping', () => {
    fs.mkdirSync(path.join(outside, 'srv'), {recursive: true});
    fs.writeFileSync(path.join(outside, 'srv', 'server.json'), '{}');
    fs.writeFileSync(path.join(outside, 'single.json'), '{}');
    fs.mkdirSync(path.join(dir, 'file-link'));
    fs.symlinkSync(path.join(outside, 'single.json'), path.join(dir, 'file-link', 'server.json'));
    fs.symlinkSync(path.join(outside, 'srv'), path.join(dir, 'dir-link'));
    fs.symlinkSync(dir, path.join(dir, 'loop'));
    fs.symlinkSync(path.join(outside, 'missing'), path.join(dir, 'dangling'));
    assert.deepStrictEqual(findServerJsons(dir), ['dir-link/server.json', 'file-link/server.json']);
  });

  it('a symlink into node_modules or a dot-directory is not walked', () => {
    for (const hidden of ['node_modules/dep', '.cache/dep']) {
      fs.mkdirSync(path.join(outside, hidden), {recursive: true});
      fs.writeFileSync(path.join(outside, hidden, 'server.json'), '{}');
    }
    fs.symlinkSync(path.join(outside, 'node_modules'), path.join(dir, 'vendor'));
    fs.symlinkSync(path.join(outside, 'node_modules', 'dep'), path.join(dir, 'dep'));
    fs.symlinkSync(path.join(outside, '.cache'), path.join(dir, 'cache'));
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'server.json'), '{}');
    assert.deepStrictEqual(findServerJsons(dir), ['real/server.json']);
  });

  it('a directory reached both directly and through a link is reported under its real path', () => {
    fs.mkdirSync(path.join(dir, 'z'));
    fs.writeFileSync(path.join(dir, 'z', 'server.json'), '{}');
    fs.symlinkSync(path.join(dir, 'z'), path.join(dir, 'a'));
    assert.deepStrictEqual(findServerJsons(dir), ['z/server.json']);
  });

  it('a root that is itself under a dot-directory still walks', () => {
    const nested = path.join(outside, '.work', 'servers');
    fs.mkdirSync(path.join(nested, 'srv'), {recursive: true});
    fs.writeFileSync(path.join(nested, 'srv', 'server.json'), '{}');
    assert.deepStrictEqual(findServerJsons(nested), ['srv/server.json']);
  });
});
