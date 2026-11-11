#!/usr/bin/env node
'use strict';
// Runs a command under the machine's shared test lock (the brief): when
// ~/countinghouse/.superpowers exists, the lock is the directory suite.lock in it,
// taken atomically with mkdir, with our name in suite.lock/owner, and removed when
// the command ends however it ends. Elsewhere (CI) the command just runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const OWNER = 'countinghouse-registry implementer';
const POLL_MS = 500;
// How long to wait for another holder, in minutes: SUITE_LOCK_MAX_WAIT_MIN, default
// 120 (a full countinghouse suite plus a queue holds the lock for over an hour).
const DEFAULT_WAIT_MIN = 120;

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  process.stderr.write('usage: with-suite-lock <command> [args...]\n');
  process.exit(2);
}
const waitRaw = process.env.SUITE_LOCK_MAX_WAIT_MIN;
const waitMin = waitRaw === undefined ? DEFAULT_WAIT_MIN : Number(waitRaw);
if (!(waitMin > 0)) {
  process.stderr.write(`with-suite-lock: SUITE_LOCK_MAX_WAIT_MIN must be a positive number of minutes, not "${waitRaw}"\n`);
  process.exit(2);
}
const MAX_WAIT_MS = waitMin * 60 * 1000;

const base = path.join(os.homedir(), 'countinghouse', '.superpowers');
const lock = path.join(base, 'suite.lock');
const useLock = fs.existsSync(base) && fs.statSync(base).isDirectory();
let held = false;

function release() {
  if (held) {
    fs.rmSync(lock, {recursive: true, force: true});
    held = false;
  }
}

function acquire(done) {
  const started = Date.now();
  let told = false;
  const attempt = () => {
    try {
      fs.mkdirSync(lock);
      held = true;
      fs.writeFileSync(path.join(lock, 'owner'), `${OWNER}, pid ${process.pid}, ${new Date().toISOString()}\n`);
      done();
    } catch (err) {
      if (err.code !== 'EEXIST') {
        release();
        process.stderr.write(`with-suite-lock: ${err.message}\n`);
        process.exit(3);
      }
      if (Date.now() - started > MAX_WAIT_MS) {
        process.stderr.write(`with-suite-lock: ${lock} still held after ${waitMin} minutes; giving up\n`);
        process.exit(3);
      }
      if (!told) {
        process.stderr.write(`with-suite-lock: waiting for ${lock}\n`);
        told = true;
      }
      setTimeout(attempt, POLL_MS);
    }
  };
  attempt();
}

// Signals that end the wrapper release the lock: forwarded to the child, whose
// exit releases it; before the child exists, released here. (SIGKILL cannot be
// caught; the owner line carries the pid so a stale lock can be identified.)
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
let child = null;
for (const sig of STOP_SIGNALS) {
  process.on(sig, () => {
    if (child) child.kill(sig);
    else {
      release();
      process.exit(128 + os.constants.signals[sig]);
    }
  });
}
process.on('uncaughtException', (err) => {
  release();
  process.stderr.write(`with-suite-lock: ${err.message}\n`);
  process.exit(3);
});

function runChild() {
  child = spawn(cmd, args, {stdio: 'inherit'});
  child.on('error', (err) => {
    release();
    process.stderr.write(`with-suite-lock: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    release();
    process.exit(code === null ? (signal ? 128 + os.constants.signals[signal] : 1) : code);
  });
}

if (useLock) acquire(runChild);
else runChild();
