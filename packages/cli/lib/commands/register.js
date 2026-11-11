'use strict';
// countinghouse-registry-cli register <dir> --registry <base URL> --domain <d> --key
// <path> (the reviewer's message of 2026-11-10): a customer with no registry of
// their own hands over a directory, and every server.json in it (at any depth,
// not under node_modules or a dot-directory) is published into a claimed
// namespace with one exchange, a record beside a pointer PUT first as publish does.
// Each file ends published, skipped (the same document is already published
// here as that version, so a rerun after a partial failure skips what is done)
// or failed (a different document under a published version among them:
// versions are immutable), with the registry's answer and its validation issues;
// a failed file never stops the others.
const fs = require('fs');
const path = require('path');
const {signIn, CliError, ApiError, enc} = require('../client');
const {sha256Canonical} = require('../canonical-json');
const {reduceMeta} = require('../validate');
const {loadEntry, publishEntry} = require('./publish');

function findServerJsons(root) {
  const found = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), {withFileTypes: true});
    } catch (err) {
      if (rel === '') throw new CliError(1, `cannot read the directory ${root} (${err.code || err.name})`);
      return;
    }
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(child);
      } else if (e.isFile() && e.name === 'server.json') {
        found.push(child);
      }
    }
  };
  walk('');
  return found.sort();
}

// The publish refused with 409: is the version served here this very document?
// -> true | false; a failed read throws (the caller reports it as such).
const sameDocument = (a, b) => sha256Canonical(reduceMeta(a)) === sha256Canonical(reduceMeta(b));
async function alreadyPublished(session, doc) {
  const {body} = await session.call('GET', `/v0.1/servers/${enc(doc.name)}/versions/${enc(doc.version)}`);
  return Boolean(body && body.server && sameDocument(body.server, doc));
}

// A file's 409 from POST /v0.1/publish -> {skipped, detail}.
async function conflictOutcome(session, doc, err) {
  try {
    if (await alreadyPublished(session, doc)) return {skipped: true, detail: 'already published here'};
    return {skipped: false, detail: `a different document is already published as ${doc.name}@${doc.version}; published versions are immutable: publish a new version`};
  } catch (readErr) {
    if (!(readErr instanceof CliError) || readErr.exitCode === 2) throw readErr;
    return {skipped: false, detail: `${err.summary}; comparing with the published version failed: ${readErr.message.split('\n')[0]}`};
  }
}

// -> {results: [{file, name, version, outcome, ok, status, detail, issues}]} (ok:
// not failed). Throws when nothing can be tried (no files, no key, a refused
// exchange), and with exit 2 when the registry stops answering mid-run, naming
// the files not tried.

async function register({dir, registry, domain, keyFile, algorithm = 'ed25519', env = process.env, fetch, onResult = () => {}}) {
  const root = path.resolve(dir);
  const files = findServerJsons(root);
  if (!files.length) throw new CliError(1, `no server.json found in ${root}`);
  const session = await signIn({registry, domain, keyFile, algorithm, env, fetch});
  const results = [];
  for (const [i, file] of files.entries()) {
    let result;
    let entry = null;
    try {
      try {
        entry = loadEntry(path.join(root, file));
        await publishEntry(session, entry);
        result = {file, name: entry.doc.name, version: entry.doc.version, outcome: 'published', ok: true, status: 200, detail: 'published', issues: []};
      } catch (err) {
        if (!(err instanceof CliError) || err.exitCode === 2) throw err;
        const doc = entry ? entry.doc : {};
        const api = err instanceof ApiError;
        const conflict = api && err.status === 409 && err.method === 'POST' && err.path === '/v0.1/publish';
        const {skipped, detail} = conflict ? await conflictOutcome(session, doc, err) : {skipped: false, detail: api ? err.summary : err.message};
        result = {file, name: doc.name, version: doc.version, outcome: skipped ? 'skipped' : 'failed', ok: skipped,
          status: api ? err.status : null, detail, issues: api ? err.issues : []};
      }
    } catch (err) {
      // The registry cannot be reached: the rest cannot be tried either.
      if (err instanceof CliError && err.exitCode === 2) throw new CliError(2, `${err.message}\nnot tried: ${files.slice(i).join(', ')}`);
      throw err;
    }
    results.push(result);
    onResult(result);
  }
  return {results};
}

module.exports = {register, findServerJsons};
