#!/usr/bin/env node
'use strict';
// The manual half of the "publishable upstream" invariant (spec section 14): posts
// every "valid here" fixture to the official registry's POST /v0.1/validate (no
// auth) and exits 1, listing them, if upstream finds any of them invalid. Run by
// hand before each release (docs/operator.md, release checklist); never in CI.
// It also sends two probes and prints upstream's answers: whether upstream accepts
// an unknown top-level field, and a _meta key beside publisher-provided (spec 7.5
// follows whatever upstream does; record a change of answer in the spec).
//
//   node scripts/check-upstream-validate.js            # fixtures, then probes
//   node scripts/check-upstream-validate.js --probes   # the two probes only
const fs = require('fs');
const path = require('path');
const pkg = require('../packages/cli/package.json');

const URL = 'https://registry.modelcontextprotocol.io/v0.1/validate';
const UA = `countinghouse-registry/${pkg.version} (+https://github.com/mchen6/countinghouse-registry)`;
const DIR = path.join(__dirname, '..', 'packages', 'cli', 'test', 'fixtures', 'valid-here');

const PROBE_BASE = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'io.github.example/probe', description: 'A probe of unknown-property handling', version: '1.0.0'
};
const PROBES = [
  {name: 'unknown top-level field', document: {...PROBE_BASE, unknownField: 1}},
  {name: '_meta key beside publisher-provided', document: {...PROBE_BASE, _meta: {
    'io.modelcontextprotocol.registry/publisher-provided': {probe: true}, 'com.example/other': {probe: true}}}}
];

const post = async (document) => {
  const res = await fetch(URL, {method: 'POST', headers: {'User-Agent': UA, 'Content-Type': 'application/json'}, body: JSON.stringify(document)});
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return {status: res.status, body};
};

async function probes() {
  for (const p of PROBES) {
    const r = await post(p.document);
    process.stdout.write(`probe: ${p.name}: ${r.status} ${JSON.stringify(r.body)}\n`);
  }
}

async function main() {
  if (process.argv.includes('--probes')) return probes();
  const failed = [];
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
    const {document} = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const {status, body} = await post(document);
    const ok = status === 200 && body && body.valid === true;
    process.stdout.write(`${ok ? 'valid  ' : 'INVALID'} ${file}\n`);
    if (!ok) failed.push({file, status, issues: body && body.issues});
  }
  await probes();
  if (failed.length) {
    process.stdout.write(`\n${failed.length} fixture(s) not valid upstream:\n${JSON.stringify(failed, null, 2)}\n`);
    process.exit(1);
  }
}

main().catch((err) => { process.stderr.write(`check-upstream-validate: ${err.message}\n`); process.exit(1); });
