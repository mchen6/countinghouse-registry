'use strict';
// countinghouse-registry-cli register <dir> --registry <base URL> --domain <d> --key
// <path> (the reviewer's message of 2026-11-10): a customer with no registry of
// their own hands over a directory, and every server.json in it (at any depth,
// not under node_modules or a dot-directory, judged by where a symlink leads;
// symlinks are followed, each real directory walked once, real directories
// before links so a directory reached both ways keeps its real path) is published into a claimed
// namespace with one exchange, a record beside a pointer PUT first as publish does.
// Each file ends published, skipped (the same document is already published
// here as that version, so a rerun after a partial failure skips what is done)
// or failed (a different document under a published version among them:
// versions are immutable), with the registry's answer and its validation issues;
// a failed file never stops the others.
const fs = require('fs');
const path = require('path');
const {signIn, CliError, ApiError, entryPath} = require('../client');
const {sha256Canonical} = require('../canonical-json');
const {reduceMeta} = require('../validate');
const {loadEntry, publishEntry} = require('./publish');

const SKIPPED = (segment) => segment === 'node_modules' || segment.startsWith('.');

function findServerJsons(root) {
  const found = [];
  const seen = new Set();
  let rootParts = null;
  // A real path is skipped when, below what it shares with the root's real
  // path, it passes through node_modules or a dot-directory.
  const hidden = (real) => {
    const parts = real.split(path.sep);
    let i = 0;
    while (i < rootParts.length && i < parts.length && parts[i] === rootParts[i]) i++;
    return parts.slice(i).some(SKIPPED);
  };
  const walk = (rel) => {
    let entries;
    try {
      const real = fs.realpathSync(path.join(root, rel));
      if (rel === '') rootParts = real.split(path.sep);
      if (seen.has(real) || hidden(real)) return;
      seen.add(real);
      // Real entries first, then links, each in name order: deterministic.
      entries = fs.readdirSync(real, {withFileTypes: true})
        .sort((a, b) => (a.isSymbolicLink() - b.isSymbolicLink()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      if (rel === '') throw new CliError(1, `cannot read the directory ${root} (${err.code || err.name})`);
      return;
    }
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      let kind = e;
      if (e.isSymbolicLink()) {
        try { kind = fs.statSync(path.join(root, child)); } catch { continue; } // dangling
      }
      if (kind.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(child);
      } else if (kind.isFile() && e.name === 'server.json') {
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
  const {body} = await session.call('GET', `/v0.1/servers/${entryPath(doc.name, doc.version)}`);
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
// the file in flight (interrupted: its record may be stored) and those not tried.

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
        // Through any symlink: the record is the one beside the real server.json.
        entry = loadEntry(fs.realpathSync(path.join(root, file)));
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
      if (err instanceof CliError && err.exitCode === 2) {
        const rest = files.slice(i + 1);
        throw new CliError(2, `${err.message}\ninterrupted: ${file} (it may be partly stored: run register again)${rest.length ? `\nnot tried: ${rest.join(', ')}` : ''}`);
      }
      throw err;
    }
    results.push(result);
    onResult(result);
  }
  return {results};
}

module.exports = {register, findServerJsons};
