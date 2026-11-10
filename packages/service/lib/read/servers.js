'use strict';
// The generic read endpoints (spec section 4.1).
const express = require('express');
const {sendJson, problem, handle} = require('../http/problem');
const {parseListParams, parseIncludeDeleted} = require('./params');
const {toServerResponse} = require('./response');

const COLUMNS = 'id, source, name, version, server, official, origin, changed_at, mirrored_at, hidden_reason';
const VISIBLE = "hidden_reason IS NULL AND json_extract(official, '$.status') <> 'deleted'";

function encodeCursor(name, version) {
  return Buffer.from(`${name}\u0000${version}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = text.split('\u0000');
  if (parts.length !== 2 || !parts[0] || !parts[1] || encodeCursor(parts[0], parts[1]) !== cursor) return null;
  return {name: parts[0], version: parts[1]};
}

function likePattern(s) {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function serversRouter({store, log, view}) {
  const router = express.Router();

  router.get('/servers', handle(log, 'Failed to list servers', async (req, res) => {
    const parsed = parseListParams(req.query);
    if (parsed.problem) return problem(res, parsed.problem.status, parsed.problem.detail, parsed.problem.errors ? {errors: parsed.problem.errors} : {});
    const p = parsed.params;
    const where = [];
    const args = [];
    if (!p.includeDeleted) where.push(VISIBLE);
    if (p.updatedSince) { where.push('changed_at > ?'); args.push(p.updatedSince); }
    if (p.search) { where.push("name IN (SELECT name FROM names WHERE id IN (SELECT rowid FROM names_fts WHERE name LIKE ? ESCAPE '\\'))"); args.push(likePattern(p.search)); }
    if (p.version === 'latest') where.push("json_extract(official, '$.isLatest') = 1");
    else if (p.version !== null) { where.push('version = ?'); args.push(p.version); }
    if (p.cursor !== null) {
      const c = decodeCursor(p.cursor);
      if (!c) return problem(res, 400, 'Invalid cursor');
      where.push('(name, version) > (?, ?)');
      args.push(c.name, c.version);
    }
    const sql = `SELECT ${COLUMNS} FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name, version LIMIT ?`;
    const rows = await store.read(sql, [...args, p.limit]);
    const servers = await Promise.all(rows.map((r) => view(r, req)));
    const metadata = {};
    if (rows.length === p.limit) {
      const last = rows[rows.length - 1];
      metadata.nextCursor = encodeCursor(last.name, last.version);
    }
    metadata.count = servers.length;
    sendJson(res, 200, {servers, metadata});
  }));

  router.get('/servers/:name/versions', handle(log, 'Failed to get server versions', async (req, res) => {
    const inc = parseIncludeDeleted(req.query);
    if (inc.problem) return problem(res, inc.problem.status, inc.problem.detail, {errors: inc.problem.errors});
    const rows = await store.read(
      `SELECT ${COLUMNS} FROM records WHERE name = ? ${inc.includeDeleted ? '' : `AND ${VISIBLE}`}`, [req.params.name]);
    if (!rows.length) return problem(res, 404, 'Server not found');
    rows.sort((a, b) => Date.parse(JSON.parse(b.official).publishedAt) - Date.parse(JSON.parse(a.official).publishedAt));
    const servers = await Promise.all(rows.map((r) => view(r, req)));
    sendJson(res, 200, {servers, metadata: {count: servers.length}});
  }));

  router.get('/servers/:name/versions/:version', handle(log, 'Failed to get server details', async (req, res) => {
    const inc = parseIncludeDeleted(req.query);
    if (inc.problem) return problem(res, inc.problem.status, inc.problem.detail, {errors: inc.problem.errors});
    const {name, version} = req.params;
    const filter = inc.includeDeleted ? '' : `AND ${VISIBLE}`;
    const rows = version === 'latest'
      ? await store.read(`SELECT ${COLUMNS} FROM records WHERE name = ? AND json_extract(official, '$.isLatest') = 1 ${filter}`, [name])
      : await store.read(`SELECT ${COLUMNS} FROM records WHERE name = ? AND version = ? ${filter}`, [name, version]);
    if (!rows.length) return problem(res, 404, 'Server not found');
    sendJson(res, 200, await view(rows[0], req));
  }));

  return router;
}

module.exports = {serversRouter, encodeCursor, decodeCursor, toServerResponse};
