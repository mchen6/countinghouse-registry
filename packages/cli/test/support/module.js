'use strict';
// A working copy of the fixture module in a temporary directory (generate writes
// server.json and countinghouse-record.json into it), with countinghouse resolvable
// from it when asked (a stub package, as an author's devDependency install would
// leave), plus fakes for the two child processes generate runs.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'module-echo');
const ECHO_TOOLS = require('../fixtures/tools-list/echo.json');

function moduleCopy({countinghouse = true, pkg} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-cli-'));
  fs.cpSync(FIXTURE, dir, {recursive: true});
  if (pkg) {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, JSON.stringify(pkg(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2));
  }
  if (countinghouse) {
    const ch = path.join(dir, 'node_modules', 'countinghouse');
    fs.mkdirSync(path.join(ch, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(ch, 'package.json'), JSON.stringify({name: 'countinghouse', version: '8.0.0', bin: {'countinghouse-validate': './bin/countinghouse-validate.js'}}));
    fs.writeFileSync(path.join(ch, 'bin', 'countinghouse-validate.js'), 'process.exit(2);\n');
  }
  return {dir, remove: () => fs.rmSync(dir, {recursive: true, force: true})};
}

// childProcess.execFile's shape: cb(err, stdout, stderr), err.code the exit code.
// `error` replaces the exit-code error (a signal kill, a maxBuffer overflow).
function fakeExec({stdout = '', code = 0, error} = {}) {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push({file, args, opts});
    setImmediate(() => cb(error || (code === 0 ? null : Object.assign(new Error(`exit ${code}`), {code})), stdout, ''));
  };
  return {exec, calls};
}

const validateOk = () => fakeExec({stdout: `${JSON.stringify({ok: true, module: 'echo', problems: [], warnings: []})}\n`});
const fixtureTools = async () => JSON.parse(JSON.stringify(ECHO_TOOLS));

module.exports = {moduleCopy, fakeExec, validateOk, fixtureTools, ECHO_TOOLS, FIXTURE};
