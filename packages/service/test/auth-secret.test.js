'use strict';
// The token signing secret (spec section 10.3): countinghouse's secret-file
// discipline (lib/identity.js). `env: null` means the variable is not set.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {loadSecret, SecretError} = require('../lib/auth/secret');

const HEX = 'ab'.repeat(32);

describe('the token signing secret', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-secret-')); });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  const refuses = (opts, pattern) => {
    let err;
    try { loadSecret(opts); } catch (e) { err = e; }
    assert.ok(err instanceof SecretError, `expected a SecretError, got ${err}`);
    assert.match(err.message, pattern);
    for (const leaked of [HEX, 'cd'.repeat(32)]) assert.ok(!err.message.includes(leaked), 'the message must not hold a secret');
    return err;
  };

  it('generates 64 hex characters with mode 0600 atomically on first start', () => {
    const file = path.join(dir, 'state', '.jwt-secret');
    const secret = loadSecret({file, env: null});
    assert.ok(Buffer.isBuffer(secret));
    assert.strictEqual(secret.length, 32);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^[0-9a-f]{64}$/);
    assert.ok(Buffer.from(text, 'hex').equals(secret));
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    // Written under a temporary name and renamed: nothing else is left behind.
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['.jwt-secret']);
    // The next start reads the same secret.
    assert.ok(loadSecret({file, env: null}).equals(secret));
  });

  it('refuses a group-readable secret file', () => {
    const file = path.join(dir, '.jwt-secret');
    fs.writeFileSync(file, HEX, {mode: 0o600});
    fs.chmodSync(file, 0o640);
    refuses({file, env: null}, /group or others \(mode 640\).*0600/);
  });

  it('refuses a world-readable secret file', () => {
    const file = path.join(dir, '.jwt-secret');
    fs.writeFileSync(file, HEX, {mode: 0o600});
    fs.chmodSync(file, 0o604);
    refuses({file, env: null}, /group or others \(mode 604\)/);
  });

  it('refuses a symlink', () => {
    const real = path.join(dir, 'real');
    fs.writeFileSync(real, HEX, {mode: 0o600});
    const file = path.join(dir, '.jwt-secret');
    fs.symlinkSync(real, file);
    refuses({file, env: null}, /symbolic link/);
  });

  it('refuses file and env both present', () => {
    const file = path.join(dir, '.jwt-secret');
    fs.writeFileSync(file, HEX, {mode: 0o600});
    // Even when they hold the same value: spec 10.3, "both present -> startup refused".
    refuses({file, env: HEX}, /COUNTINGHOUSE_REGISTRY_SECRET.*both|both.*COUNTINGHOUSE_REGISTRY_SECRET/);
    refuses({file, env: 'cd'.repeat(32)}, /COUNTINGHOUSE_REGISTRY_SECRET/);
  });

  it('accepts the env var in the same form', () => {
    const file = path.join(dir, '.jwt-secret');
    const secret = loadSecret({file, env: HEX});
    assert.ok(secret.equals(Buffer.from(HEX, 'hex')));
    assert.ok(!fs.existsSync(file), 'no file is generated when the variable is set');
  });

  it('refuses a malformed value', () => {
    const file = path.join(dir, '.jwt-secret');
    refuses({file, env: 'AB'.repeat(32)}, /COUNTINGHOUSE_REGISTRY_SECRET must be 64 hex characters/);
    refuses({file, env: 'ab'.repeat(31)}, /64 hex characters/);
    fs.writeFileSync(file, 'not a secret', {mode: 0o600});
    refuses({file, env: null}, /must hold the secret as 64 hex characters/);
  });

  it('checks the file it reads: a swap to a link after the first check is refused', () => {
    const real = path.join(dir, 'real');
    fs.writeFileSync(real, HEX, {mode: 0o600});
    const file = path.join(dir, '.jwt-secret');
    fs.symlinkSync(real, file);
    // The first look sees a regular 0600 file; the path is a link when it is read.
    const lstat = fs.lstatSync;
    fs.lstatSync = (p, ...rest) => (p === file ? lstat(real, ...rest) : lstat(p, ...rest));
    try {
      refuses({file, env: null}, /symbolic link/);
    } finally {
      fs.lstatSync = lstat;
    }
  });

  it('a temporary file left by a crashed first start does not stop the next one', () => {
    const file = path.join(dir, '.jwt-secret');
    fs.writeFileSync(`${file}.${process.pid}.tmp`, 'partial', {mode: 0o600});
    const secret = loadSecret({file, env: null});
    assert.strictEqual(fs.readFileSync(file, 'utf8'), secret.toString('hex'));
  });

  it('refuses a path that is not a regular file', () => {
    refuses({file: dir, env: null}, /not a regular file/);
  });
});
