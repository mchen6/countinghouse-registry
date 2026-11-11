'use strict';
// The token signing secret (spec section 10.3). It follows countinghouse's
// secret-file discipline (github.com/mchen6/countinghouse lib/identity.js at
// 8559f5e71fb3a663dd6a25199de4c92c3e1323b9, R2-1 task 1, and
// docs/superpowers/specs/2026-11-07-r2-1-no-raw-keys-in-modules-design.md):
// 32 random bytes kept as 64 hex characters in a file of mode 0600, never read
// through a link, generated on first start and written atomically; or supplied
// as COUNTINGHOUSE_REGISTRY_SECRET in the same form. One difference, from the
// spec: a file and the variable both present refuse startup even when they
// agree (countinghouse refuses only when they differ). Messages never hold a
// secret.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV = 'COUNTINGHOUSE_REGISTRY_SECRET';
const FORM = /^[0-9a-f]{64}$/;

class SecretError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretError';
    this.code = 'REGISTRY_SECRET_INVALID';
  }
}

function present(v) {
  return v !== undefined && v !== null;
}

// The checks apply to the file that is read: it is opened without following a
// link and checked through its descriptor, so a swap after the first look is
// refused too.
function readChecked(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP') throw new SecretError(`${file} is a symbolic link; the secret is never read through a link`);
    throw new SecretError(`${file}: cannot be read (${e.code || e.name})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new SecretError(`${file} is not a regular file`);
    if ((st.mode & 0o077) !== 0) {
      throw new SecretError(`${file} is accessible by group or others (mode ${(st.mode & 0o777).toString(8)}); it must be 0600`);
    }
    const text = fs.readFileSync(fd, 'utf8').trim();
    if (!FORM.test(text)) throw new SecretError(`${file} must hold the secret as 64 hex characters (32 bytes)`);
    return Buffer.from(text, 'hex');
  } finally {
    fs.closeSync(fd);
  }
}

// -> Buffer (32 bytes). Throws SecretError (startup refuses, exit 2).
function loadSecret({file, env = process.env[ENV]}) {
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new SecretError(`${file}: cannot be read (${e.code || e.name})`);
  }
  if (present(env) && st !== null) {
    throw new SecretError(`${ENV} and ${file} are both present; keep one of them (changing the secret ends every token issued)`);
  }
  if (present(env)) {
    if (!FORM.test(env)) throw new SecretError(`${ENV} must be 64 hex characters (32 bytes), lower case`);
    return Buffer.from(env, 'hex');
  }
  if (st !== null) return readChecked(file);
  // First start: written whole under a temporary name and renamed into place,
  // so no reader ever sees a partial file. The name is random, so a temporary
  // file left by a crash (or the same pid in a container) is never in the way.
  const generated = crypto.randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    fs.writeFileSync(tmp, generated, {mode: 0o600, flag: 'wx'});
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw new SecretError(`${file} cannot be created (${e.code || e.name}); set secret.file to a writable path or set ${ENV}`);
  }
  return Buffer.from(generated, 'hex');
}

module.exports = {loadSecret, SecretError, ENV};
