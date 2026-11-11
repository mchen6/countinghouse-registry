'use strict';
// End to end: the real service binary against a fake upstream, both on ports in
// 9700-9719 (under the shared lock).
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {listen} = require('./support/http');

const BIN = path.join(__dirname, '..', 'bin', 'countinghouse-registry.js');
const OFFICIAL = 'io.modelcontextprotocol.registry/official';

function freePort() {
  return new Promise((resolve, reject) => {
    const tryOne = (p) => {
      if (p > 9719) return reject(new Error('no free port'));
      const s = http.createServer().once('error', () => tryOne(p + 1)).listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryOne(9700);
  });
}

describe('service binary', () => {
  let dir;
  let upstream;
  let child;
  let seenUA = null;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-bin-'));
    upstream = await listen((req, res) => {
      seenUA = req.headers['user-agent'];
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/v0.1/version')) return res.end(JSON.stringify({version: '9.9.9', git_commit: 'x', build_time: 'y'}));
      const t = '2026-11-01T00:00:00Z';
      res.end(JSON.stringify({servers: [{server: {name: 'io.example/one', description: 'd', version: '1.0.0'},
        _meta: {[OFFICIAL]: {status: 'active', statusChangedAt: t, publishedAt: t, updatedAt: t, isLatest: true}}}], metadata: {count: 1}}));
    });
  });
  after(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await upstream.close();
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('starts, mirrors the upstream, serves it, and stops cleanly on SIGTERM', async () => {
    const port = await freePort();
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({listen: {port}, store: {path: path.join(dir, 'r.db')}, upstream: {url: upstream.url}}));
    child = spawn(process.execPath, [BIN, '--config', config], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let body = null;
    for (let i = 0; i < 100 && !(body && body.servers.length); i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { body = await (await fetch(`http://127.0.0.1:${port}/v0.1/servers`)).json(); } catch { body = null; }
    }
    assert.ok(body && body.servers.length === 1, `nothing mirrored; output:\n${out}`);
    assert.strictEqual(body.servers[0].server.name, 'io.example/one');
    assert.match(seenUA, /^countinghouse-registry\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/mchen6\/countinghouse-registry\)$/);
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({code, signal})));
    child.kill('SIGTERM');
    assert.deepStrictEqual(await exited, {code: 0, signal: null}, out);
  }).timeout(20000);

  it('refuses a bad config with exit 2 and the field', async () => {
    const config = path.join(dir, 'bad.json');
    fs.writeFileSync(config, JSON.stringify({store: {path: path.join(dir, 'x.db')}, upstream: {intervalMinutes: 1}}));
    const c = spawn(process.execPath, [BIN, '--config', config], {stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => c.on('exit', r));
    assert.strictEqual(code, 2);
    assert.match(err, /\/upstream\/intervalMinutes/);
  });
});
