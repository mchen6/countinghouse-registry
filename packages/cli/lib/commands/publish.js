'use strict';
// countinghouse-registry-cli publish <module dir> --registry <base URL> --domain <d>
// --key <path> (spec 11.5): a dns-style exchange (10.2), PUT
// countinghouse-record.json (8.4), then POST server.json to /v0.1/publish. The
// pointer is checked against the record on disk before anything is sent.
const fs = require('fs');
const path = require('path');
const {signIn, CliError, recordPath} = require('../client');
const {recordHash, pointerOf} = require('../record');

const hex12 = (h) => (typeof h === 'string' ? h.slice(0, 12) : String(h));

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(1, `cannot read ${what} ${file} (${err.code || err.name})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(1, `${what} ${file} is not valid JSON`);
  }
}

// A server.json and, when it carries our pointer, the record beside it, checked
// against each other: -> {doc, record | null}.
function loadEntry(serverJsonPath) {
  const doc = readJson(serverJsonPath, 'server.json');
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CliError(1, `server.json ${serverJsonPath} is not a JSON object`);
  const pointer = pointerOf(doc);
  if (!pointer) return {doc, record: null};
  const recordFile = path.join(path.dirname(serverJsonPath), 'countinghouse-record.json');
  const record = readJson(recordFile, 'the record');
  const onDisk = recordHash(record);
  if (onDisk !== pointer.sha256) {
    throw new CliError(1, `the record on disk (sha256 ${hex12(onDisk)}…) does not match the pointer in server.json (sha256 ${hex12(pointer.sha256)}…): run generate again`);
  }
  return {doc, record};
}

// PUT the record (if any), then publish: -> {name, version, record: {status, sha256} | null, published}.
async function publishEntry(session, {doc, record}) {
  const {name, version} = doc;
  let stored = null;
  if (record) {
    if (typeof name !== 'string' || typeof version !== 'string') throw new CliError(1, 'server.json needs a name and a version');
    const r = await session.call('PUT', recordPath(name, version), record);
    stored = {status: r.status, sha256: r.body && r.body.sha256};
  }
  await session.call('POST', '/v0.1/publish', doc);
  return {name, version, record: stored, published: true};
}

async function publish({dir, registry, domain, keyFile, algorithm = 'ed25519', env = process.env, fetch}) {
  const entry = loadEntry(path.join(path.resolve(dir), 'server.json'));
  const session = await signIn({registry, domain, keyFile, algorithm, env, fetch});
  return publishEntry(session, entry);
}

module.exports = {publish, publishEntry, loadEntry, readJson};
