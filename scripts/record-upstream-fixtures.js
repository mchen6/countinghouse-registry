#!/usr/bin/env node
'use strict';
// Records read-API fixtures from the official MCP Registry (run by hand, never in
// CI): status, content-type, CORS headers and body of each case, with the date and
// the upstream version. The read-API tests compare our responses against them.
//
//   node scripts/record-upstream-fixtures.js packages/service/test/fixtures/upstream
const fs = require('fs');
const path = require('path');
const pkg = require('../packages/service/package.json');

const BASE = 'https://registry.modelcontextprotocol.io';
const UA = `countinghouse-registry/${pkg.version} (+https://github.com/mchen6/countinghouse-registry)`;
const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: record-upstream-fixtures <output dir>\n');
  process.exit(2);
}

async function get(p) {
  const res = await fetch(`${BASE}${p}`, {headers: {'User-Agent': UA, 'Origin': 'https://example.org'}});
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return {
    path: p,
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type'),
      'access-control-allow-origin': res.headers.get('access-control-allow-origin'),
      'access-control-expose-headers': res.headers.get('access-control-expose-headers')
    },
    body
  };
}

async function main() {
  fs.mkdirSync(out, {recursive: true});
  const version = (await get('/v0.1/version')).body.version;
  const recordedAt = new Date().toISOString();
  const first = await get('/v0.1/servers?limit=2&version=latest');
  const name = first.body.servers[1].server.name;
  const enc = encodeURIComponent(name);
  const cases = {
    'list-limit-2': '/v0.1/servers?limit=2',
    'list-latest-limit-2': '/v0.1/servers?limit=2&version=latest',
    'versions': `/v0.1/servers/${enc}/versions`,
    'detail-latest': `/v0.1/servers/${enc}/versions/latest`,
    'not-found': '/v0.1/servers/nope%2Fnope/versions/latest',
    'not-found-versions': '/v0.1/servers/nope%2Fnope/versions',
    'search-too-short': '/v0.1/servers?search=ab',
    'limit-101': '/v0.1/servers?limit=101',
    'limit-0': '/v0.1/servers?limit=0',
    'limit-abc': '/v0.1/servers?limit=abc',
    'bad-updated-since': '/v0.1/servers?updated_since=yesterday',
    'include-deleted-false-with-updated-since': '/v0.1/servers?updated_since=2026-11-01T00:00:00Z&include_deleted=false&limit=1',
    'include-deleted-maybe': '/v0.1/servers?include_deleted=maybe&limit=1',
    'health': '/v0.1/health',
    'version': '/v0.1/version',
    'ping': '/v0.1/ping'
  };
  for (const [file, p] of Object.entries(cases)) {
    const r = await get(p);
    fs.writeFileSync(path.join(out, `${file}.json`), `${JSON.stringify({recordedAt, upstreamVersion: version, ...r}, null, 2)}\n`);
    process.stdout.write(`${file}: ${r.status}\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
