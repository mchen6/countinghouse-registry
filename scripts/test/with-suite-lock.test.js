'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'with-suite-lock.js');

function run(home, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {env: {...process.env, HOME: home}, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({code, out}));
  });
}

describe('with-suite-lock', () => {
  let home;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-lock-')); });
  afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

  const lockDir = () => path.join(home, 'countinghouse', '.superpowers', 'suite.lock');

  it('takes and releases the lock when ~/countinghouse/.superpowers exists', async () => {
    fs.mkdirSync(path.join(home, 'countinghouse', '.superpowers'), {recursive: true});
    const probe = `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(lockDir(), 'owner'))}, 'utf8'))`;
    const r = await run(home, [process.execPath, '-e', probe]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /countinghouse-registry implementer/);
    assert.ok(!fs.existsSync(lockDir()), 'lock left behind');
  });

  it('runs without a lock when the directory does not exist', async () => {
    const r = await run(home, [process.execPath, '-e', 'process.exit(0)']);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!fs.existsSync(path.join(home, 'countinghouse')));
  });

  it('waits while the lock is held', async () => {
    fs.mkdirSync(lockDir(), {recursive: true});
    const started = Date.now();
    setTimeout(() => fs.rmSync(lockDir(), {recursive: true, force: true}), 1200);
    const r = await run(home, [process.execPath, '-e', 'process.exit(0)']);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(Date.now() - started >= 1100, 'did not wait for the lock');
    assert.ok(!fs.existsSync(lockDir()));
  }).timeout(10000);

  it("passes the child's exit code through and removes the lock on failure", async () => {
    fs.mkdirSync(path.join(home, 'countinghouse', '.superpowers'), {recursive: true});
    const r = await run(home, [process.execPath, '-e', 'process.exit(7)']);
    assert.strictEqual(r.code, 7);
    assert.ok(!fs.existsSync(lockDir()));
  });
  it('releases the lock when the wrapper itself is told to stop (SIGHUP)', async () => {
    fs.mkdirSync(path.join(home, 'countinghouse', '.superpowers'), {recursive: true});
    const child = spawn(process.execPath, [SCRIPT, process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
      {env: {...process.env, HOME: home}, stdio: 'ignore'});
    while (!fs.existsSync(path.join(lockDir(), 'owner'))) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGHUP');
    await new Promise((r) => child.on('exit', r));
    assert.ok(!fs.existsSync(lockDir()), 'lock left behind after SIGHUP');
  }).timeout(10000);

  it('names its pid in the owner file', async () => {
    fs.mkdirSync(path.join(home, 'countinghouse', '.superpowers'), {recursive: true});
    const probe = `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(lockDir(), 'owner'))}, 'utf8'))`;
    const r = await run(home, [process.execPath, '-e', probe]);
    assert.match(r.out, /countinghouse-registry implementer, pid \d+/);
  });
});

