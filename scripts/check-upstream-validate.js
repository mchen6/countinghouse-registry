#!/usr/bin/env node
'use strict';
// The manual half of the "publishable upstream" invariant (spec section 14): posts
// every "valid here" fixture to the official registry's POST /v0.1/validate (no
// auth) and exits 1, listing them, if upstream finds any of them invalid. Run by
// hand before each release (docs/operator.md, release checklist); never in CI.
//
//   node scripts/check-upstream-validate.js
const fs = require('fs');
const path = require('path');
const pkg = require('../packages/cli/package.json');

const URL = 'https://registry.modelcontextprotocol.io/v0.1/validate';
const UA = `countinghouse-registry/${pkg.version} (+https://github.com/mchen6/countinghouse-registry)`;
const DIR = path.join(__dirname, '..', 'packages', 'cli', 'test', 'fixtures', 'valid-here');

async function main() {
  const failed = [];
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
    const {document} = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const res = await fetch(URL, {method: 'POST', headers: {'User-Agent': UA, 'Content-Type': 'application/json'}, body: JSON.stringify(document)});
    const body = await res.json().catch(() => null);
    const ok = res.status === 200 && body && body.valid === true;
    process.stdout.write(`${ok ? 'valid  ' : 'INVALID'} ${file}\n`);
    if (!ok) failed.push({file, status: res.status, issues: body && body.issues});
  }
  if (failed.length) {
    process.stdout.write(`\n${failed.length} fixture(s) not valid upstream:\n${JSON.stringify(failed, null, 2)}\n`);
    process.exit(1);
  }
}

main().catch((err) => { process.stderr.write(`check-upstream-validate: ${err.message}\n`); process.exit(1); });
