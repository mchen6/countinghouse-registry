'use strict';
// countinghouse-registry-cli generate <module dir> --registry <base URL> (spec 11.4):
// countinghouse-validate --json from the module's own countinghouse install, the
// package.json checks of 11.1, the tool list from countinghouse's
// toolsListForModule in a child node process (it loads module code), then
// countinghouse-record.json (8.1, 8.2) and server.json (schema 2025-12-11) with the
// pointer (8.3), validated offline as publish validates it (7.5).
// Exit codes: 0 ok, 1 problems, 2 cannot run.
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {CliError, X, checkRegistry} = require('../client');
const {isStrictSemver} = require('../semver');
const {validateRecord, recordHash, PUBLISHER_PROVIDED, POINTER_KEY} = require('../record');
const {validateServerJson, CURRENT_SCHEMA} = require('../validate');

const MCP_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const MAX_DESCRIPTION = 100;
const LAUNCHER = './bin/countinghouse-launch.js';
const FILES = ['api.json', 'schema.json', 'handlers/', 'bin/', 'server.json', 'countinghouse-record.json'];
const TOOLS_LIST = 'countinghouse/lib/mcp/tools-list-for-module';
const MAX_BUFFER = 64 * 1024 * 1024;
// A child that has not answered by then is stopped (killed by SIGTERM -> exit 2).
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;

const KEY_HEADER_TEXT = 'The countinghouse API key: the demo key the module prints on first start, or the value of COUNTINGHOUSE_API_KEY';
const KEY_ENV_TEXT = 'Runs the module with this single API key instead of a demo key; send the same value as the X-CH-Key header';

// childProcess.execFile as a promise that resolves on any exit: {code, stdout,
// stderr}. A child that could not run, was killed (a signal, the timeout) or
// overflowed its buffer is CliError 2 naming the step.
function run(exec, step, file, args, opts) {
  return new Promise((resolve, reject) => {
    exec(file, args, {maxBuffer: MAX_BUFFER, timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGTERM', ...opts}, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        return reject(new CliError(2, `${step} could not run: ${err.signal ? `killed by ${err.signal}` : (err.code || err.name)}`));
      }
      return resolve({code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '')});
    });
  });
}

// The last stdout line that parses as a JSON object (a module may print first).
function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* not this line */ }
  }
  return null;
}

function resolveCountinghouse(dir) {
  let pkgPath;
  try {
    pkgPath = require.resolve('countinghouse/package.json', {paths: [dir]});
  } catch {
    throw new CliError(2, `countinghouse cannot be resolved from ${dir}: install it as a devDependency alongside the peer dependency (npm install --save-dev countinghouse)`);
  }
  const root = path.dirname(pkgPath);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin['countinghouse-validate'] : undefined;
  if (typeof bin !== 'string') throw new CliError(2, `countinghouse ${pkg.version} at ${root} has no countinghouse-validate`);
  return {root, version: pkg.version, validateBin: path.join(root, bin)};
}

async function runValidate(exec, ch, dir) {
  const r = await run(exec, 'countinghouse-validate', process.execPath, [ch.validateBin, '--json', dir], {cwd: dir});
  const report = lastJsonLine(r.stdout);
  if (r.code === 2 || !report || typeof report.error === 'string') {
    throw new CliError(2, `countinghouse-validate could not check ${dir}: ${report && typeof report.error === 'string' ? report.error : `exit ${r.code}`}`);
  }
  if (report.ok === true && r.code === 0) return;
  const problems = Array.isArray(report.problems) ? report.problems : [];
  const lines = problems.map((p) => `  [${p.stage}] ${p.message}${p.fix ? `\n      fix: ${p.fix}` : ''}`);
  throw new CliError(1, `countinghouse-validate found ${problems.length} problem(s) in ${dir}:\n${lines.join('\n')}`);
}

const unscoped = (name) => name.replace(/^@[^/]+\//, '');

// npm's repository forms -> server.json's {url, source, subfolder?}, or a problem.
function repositoryOf(repo) {
  const r = typeof repo === 'string' ? {url: repo} : repo;
  if (!r || typeof r.url !== 'string') return {problem: 'add repository (the module\'s GitHub or GitLab repository) to package.json'};
  let url = r.url.trim().replace(/^git\+/, '');
  const short = /^(github|gitlab):([\w.-]+\/[\w.-]+)$/.exec(url) || /^()([\w.-]+\/[\w.-]+)$/.exec(url);
  if (short) url = `https://${short[1] || 'github'}.com/${short[2]}`;
  url = url.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '').replace(/\/+$/, '');
  const host = /^https:\/\/(www\.)?(github|gitlab)\.com\//.exec(url);
  if (!host) return {problem: `repository ${r.url} is not on github.com or gitlab.com, the hosts the registry accepts`};
  const out = {url, source: host[2]};
  if (typeof r.directory === 'string' && r.directory !== '') out.subfolder = r.directory.replace(/^\.\//, '').replace(/\/+$/, '');
  return {value: out};
}

// The 11.1 package shape and the 11.4 step 2 checks: every problem at once.
function checkPackage(pkg) {
  const problems = [];
  const {mcpName, version, description} = pkg;
  if (mcpName === undefined) problems.push('add mcpName (the server.json name, e.g. io.github.you/module) to package.json');
  else if (typeof mcpName !== 'string' || !MCP_NAME.test(mcpName) || mcpName.length < 3 || mcpName.length > 200) {
    problems.push(`mcpName ${mcpName} is not valid: it must match ${MCP_NAME.source} and be 3 to 200 characters`);
  }
  if (typeof version !== 'string' || !isStrictSemver(version)) problems.push(`version ${version} is not strict semver (MAJOR.MINOR.PATCH)`);
  if (typeof description !== 'string' || description.trim() === '') problems.push(`add a description (at most ${MAX_DESCRIPTION} characters) to package.json`);
  else if ([...description].length > MAX_DESCRIPTION) problems.push(`description is ${[...description].length} characters; the registry allows ${MAX_DESCRIPTION}: shorten it in package.json`);
  if (typeof pkg.name !== 'string' || pkg.name === '') problems.push('add name to package.json');
  else {
    const bin = pkg.bin;
    const key = unscoped(pkg.name);
    const entries = bin && typeof bin === 'object' ? Object.entries(bin) : [];
    const ok = entries.length === 1 && entries[0][0] === key && path.posix.normalize(entries[0][1]) === path.posix.normalize(LAUNCHER);
    if (!ok) problems.push(`bin must be exactly {"${key}": "${LAUNCHER}"} (countinghouse's scaffold emits the launcher)`);
  }
  const files = Array.isArray(pkg.files) ? pkg.files.map((f) => String(f).replace(/^\.\//, '')) : [];
  const missing = FILES.filter((f) => !files.includes(f) && !files.includes(f.replace(/\/$/, '')));
  if (missing.length) problems.push(`files must include ${missing.join(', ')}`);
  const repo = repositoryOf(pkg.repository);
  if (repo.problem) problems.push(repo.problem);
  const peer = pkg.peerDependencies && pkg.peerDependencies.countinghouse;
  if (typeof peer !== 'string' || peer === '') problems.push('add peerDependencies.countinghouse (e.g. "^8") to package.json');
  if (pkg.homepage !== undefined && !/^https:\/\//.test(String(pkg.homepage))) problems.push(`homepage ${pkg.homepage} must be an https URL (it becomes websiteUrl)`);
  return {problems, repository: repo.value};
}

// The default tool-list source: countinghouse's export, in a child node process
// in the module directory. It prints one JSON line last, {tools} or {error}, and
// exits once it is written, whatever handles the module left open.
const CHILD = `
const dir = process.argv[1];
const done = (v) => process.stdout.write('\\n' + JSON.stringify(v) + '\\n', () => process.exit(0));
let mod = null;
try { mod = require(require.resolve(${JSON.stringify(TOOLS_LIST)}, {paths: [dir]})); }
catch (err) { done({error: {code: 'NO_EXPORT', message: err.message}}); }
if (mod) Promise.resolve().then(() => mod.toolsListForModule(dir)).then(
  (out) => done({tools: out && out.tools}),
  (err) => done({error: {code: err && err.code, message: err && err.message}}));
`;

function defaultToolsList(exec) {
  return async (dir) => {
    const r = await run(exec, 'the tool-list child process', process.execPath, ['-e', CHILD, dir], {cwd: dir});
    const out = lastJsonLine(r.stdout);
    if (!out) throw new CliError(2, `the tool-list child process exited ${r.code} without an answer${r.stderr ? `: ${r.stderr.trim().split('\n').pop()}` : ''}`);
    if (out.error) {
      if (out.error.code === 'NO_EXPORT') throw new CliError(2, `the installed countinghouse has no lib/mcp/tools-list-for-module (countinghouse N1 adds it): ${out.error.message.split('\n')[0]}`);
      throw Object.assign(new Error(out.error.message || 'toolsListForModule failed'), {code: out.error.code});
    }
    return {tools: out.tools};
  };
}

function serverJsonOf(pkg, repository, registry, sha256) {
  const base = registry.replace(/\/+$/, '');
  const doc = {
    $schema: CURRENT_SCHEMA,
    name: pkg.mcpName,
    description: pkg.description,
    version: pkg.version,
    repository
  };
  if (pkg.homepage !== undefined) doc.websiteUrl = pkg.homepage;
  doc.packages = [{
    registryType: 'npm',
    identifier: pkg.name,
    version: pkg.version,
    runtimeHint: 'npx',
    transport: {
      type: 'streamable-http',
      url: 'http://{host}:{port}/mcp',
      headers: [{name: 'X-CH-Key', description: KEY_HEADER_TEXT, isRequired: true, isSecret: true}]
    },
    packageArguments: [
      {type: 'named', name: '--port', description: 'TCP port the /mcp endpoint listens on', valueHint: 'port', format: 'number', default: '9527'},
      {type: 'named', name: '--bindAddr', description: 'Address the /mcp endpoint binds to', valueHint: 'host', default: '127.0.0.1'}
    ],
    environmentVariables: [{name: 'COUNTINGHOUSE_API_KEY', description: KEY_ENV_TEXT, isRequired: false, isSecret: true}]
  }];
  doc._meta = {[PUBLISHER_PROVIDED]: {[POINTER_KEY]: {
    record: `${base}${X}/records/${encodeURIComponent(pkg.mcpName)}/versions/${encodeURIComponent(pkg.version)}`,
    sha256,
    recordVersion: 1
  }}};
  return doc;
}

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// -> {serverJsonPath, recordPath, sha256}; throws CliError(1|2).
async function generate({dir, registry, exec = childProcess.execFile, toolsList}) {
  checkRegistry(registry);
  const root = path.resolve(dir);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (err) {
    throw new CliError(2, `cannot read ${path.join(root, 'package.json')} (${err.code || err.name})`);
  }
  // 1. countinghouse-validate, from the module's own install.
  const ch = resolveCountinghouse(root);
  await runValidate(exec, ch, root);
  // 2. package.json.
  const {problems, repository} = checkPackage(pkg);
  if (problems.length) throw new CliError(1, `package.json in ${root} needs changes before generate:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  // 3. The tool list.
  let listed;
  try {
    listed = await (toolsList || defaultToolsList(exec))(root);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (err && err.code === 'MODULE_DISCOVERS_DEVICES') {
      throw new CliError(1, `${pkg.mcpName} discovers its devices at run time, so its tool list cannot be read from the directory: run the capture against a server instead (spec 11.2; version 1 has no record for such a module)`);
    }
    throw new CliError(1, `toolsListForModule failed for ${root}: ${err && err.message}`);
  }
  // 4. The record.
  const c = pkg.countinghouse && typeof pkg.countinghouse === 'object' ? pkg.countinghouse : {};
  const record = {
    recordVersion: 1,
    countinghouse: pkg.peerDependencies.countinghouse,
    tools: listed && listed.tools,
    calls: c.calls === undefined ? [] : c.calls,
    permissions: c.permissions === undefined ? {} : c.permissions
  };
  const checked = validateRecord(record);
  if (!checked.valid) throw new CliError(1, `the tool list does not make a valid record:\n${checked.errors.map((e) => `  ${e}`).join('\n')}`);
  const sha256 = recordHash(record);
  // 5, 6. server.json, validated before either file is written.
  const doc = serverJsonOf(pkg, repository, registry, sha256);
  const result = validateServerJson(doc);
  if (!result.valid) {
    const lines = result.issues.filter((i) => i.severity === 'error').map((i) => `  ${i.path || '(document)'}: ${i.message}`);
    throw new CliError(1, `the server.json generated for ${root} does not validate:\n${lines.join('\n')}`);
  }
  const recordPath = path.join(root, 'countinghouse-record.json');
  const serverJsonPath = path.join(root, 'server.json');
  writeJson(recordPath, record);
  writeJson(serverJsonPath, doc);
  return {serverJsonPath, recordPath, sha256};
}

module.exports = {generate, checkPackage, repositoryOf, KEY_HEADER_TEXT, KEY_ENV_TEXT};
