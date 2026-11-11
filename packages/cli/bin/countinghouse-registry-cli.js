#!/usr/bin/env node
'use strict';
// countinghouse-registry-cli: generate, publish and register entries, and the
// operator commands (spec 11.4, 11.5, 12). Exit codes: 0 ok, 1 problems (or a
// refusal), 2 cannot run. main(argv, io) is the whole program, for tests.
const {parseArgs} = require('util');
const {CliError} = require('../lib/client');
const {generate} = require('../lib/commands/generate');
const {publish} = require('../lib/commands/publish');
const {register} = require('../lib/commands/register');
const {operatorCommand, COMMANDS, isCommand, usageOf} = require('../lib/commands/operator');

const SIGNED = '--registry <base URL> --domain <d> --key <path> [--algorithm ed25519|ecdsa-p384]';
const USAGE = [
  'usage: countinghouse-registry-cli <command> ...',
  '',
  '  generate <module dir> --registry <base URL>   write countinghouse-record.json and server.json',
  `  publish <module dir> ${SIGNED}`,
  '                                                PUT the record, then publish server.json',
  `  register <dir> ${SIGNED}`,
  '                                                publish every server.json under <dir>',
  ...Object.keys(COMMANDS).map((c) => `  ${usageOf(c).replace(/^usage: countinghouse-registry-cli /, '')}`),
  '',
  'The private key (hex, as mcp-publisher takes it) is read from --key <path> or',
  'COUNTINGHOUSE_REGISTRY_PRIVATE_KEY; it is never printed.'
].join('\n');

const OPTIONS = {
  registry: {type: 'string'}, domain: {type: 'string'}, key: {type: 'string'}, algorithm: {type: 'string'},
  remote: {type: 'string'}, since: {type: 'string'}, limit: {type: 'string'}, upstream: {type: 'string'},
  remove: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}
};

// The options each command takes (beyond --help); any other is refused with the
// command's usage, so a flag is never silently dropped.
const SIGNED_OPTIONS = ['registry', 'domain', 'key', 'algorithm'];
const USAGES = {
  generate: 'usage: countinghouse-registry-cli generate <module dir> --registry <base URL>',
  publish: `usage: countinghouse-registry-cli publish <module dir> ${SIGNED}`,
  register: `usage: countinghouse-registry-cli register <dir> ${SIGNED}`
};
function optionsOf(command) {
  if (command === 'generate') return ['registry'];
  if (command === 'publish' || command === 'register') return SIGNED_OPTIONS;
  return [...SIGNED_OPTIONS, ...(COMMANDS[command].options || [])];
}
const usageFor = (command) => USAGES[command] || usageOf(command);

function onlyTaken(command, values) {
  const allowed = optionsOf(command);
  const extra = Object.keys(values).filter((k) => k !== 'help' && !allowed.includes(k));
  if (extra.length) throw new CliError(1, `${command} does not take ${extra.map((k) => `--${k}`).join(', ')}\n${usageFor(command)}`);
}

function needs(values, names, command) {
  const missing = names.filter((n) => values[n] === undefined);
  if (missing.length) throw new CliError(1, `${command} needs ${missing.map((n) => `--${n}`).join(', ')}`);
}

async function run(command, positionals, values, io) {
  const say = (line) => io.stdout.write(`${line}\n`);
  if (command === 'generate' || command === 'publish' || command === 'register' || isCommand(command)) onlyTaken(command, values);
  const signed = {registry: values.registry, domain: values.domain, keyFile: values.key, algorithm: values.algorithm, env: io.env, fetch: io.fetch};
  if (command === 'generate') {
    if (positionals.length !== 1) throw new CliError(1, USAGES.generate);
    needs(values, ['registry'], 'generate');
    const out = await generate({dir: positionals[0], registry: values.registry, ...(io.exec ? {exec: io.exec} : {})});
    say(`wrote ${out.recordPath} (sha256 ${out.sha256})`);
    say(`wrote ${out.serverJsonPath}`);
    return 0;
  }
  if (command === 'publish') {
    if (positionals.length !== 1) throw new CliError(1, USAGES.publish);
    needs(values, ['registry', 'domain'], 'publish');
    const out = await publish({dir: positionals[0], ...signed});
    if (out.record) say(`stored the record for ${out.name}@${out.version} (sha256 ${out.record.sha256}, ${out.record.status === 201 ? 'new' : 'already stored'})`);
    say(`published ${out.name}@${out.version}`);
    return 0;
  }
  if (command === 'register') {
    if (positionals.length !== 1) throw new CliError(1, USAGES.register);
    needs(values, ['registry', 'domain'], 'register');
    const onResult = (r) => {
      const what = r.name === undefined ? '' : r.version === undefined ? ` ${r.name}` : ` ${r.name}@${r.version}`;
      if (r.outcome === 'published') say(`ok   ${r.file}${what}`);
      else say(`${r.outcome === 'skipped' ? 'skip' : 'FAIL'} ${r.file}${what}: ${r.detail}`);
      for (const issue of r.issues) say(`     ${issue}`);
    };
    const {results} = await register({dir: positionals[0], ...signed, onResult});
    const count = (o) => results.filter((r) => r.outcome === o).length;
    say(`${count('published')} published, ${count('skipped')} skipped, ${count('failed')} failed`);
    return count('failed') === 0 ? 0 : 1;
  }
  if (isCommand(command)) {
    needs(values, ['registry', 'domain'], command);
    const body = await operatorCommand(command, positionals, {...signed, remote: values.remote, since: values.since, limit: values.limit, upstream: values.upstream, remove: values.remove});
    say(JSON.stringify(body, null, 2));
    return 0;
  }
  throw new CliError(1, `unknown command ${command}\n${USAGE}`);
}

// -> the exit code. io: {stdout, stderr, env, fetch?, exec?}.
async function main(argv, io = {stdout: process.stdout, stderr: process.stderr, env: process.env}) {
  let parsed;
  try {
    parsed = parseArgs({args: argv, options: OPTIONS, allowPositionals: true, strict: true});
  } catch (err) {
    io.stderr.write(`${err.message}\n${USAGE}\n`);
    return 1;
  }
  const [command, ...positionals] = parsed.positionals;
  if (parsed.values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!command) {
    io.stderr.write(`${USAGE}\n`);
    return 1;
  }
  try {
    return await run(command, positionals, parsed.values, io);
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    io.stderr.write(`countinghouse-registry-cli: unexpected error (${err && (err.code || err.name)})\n`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = {main, USAGE};
