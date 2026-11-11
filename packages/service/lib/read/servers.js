'use strict';
// The generic read endpoints (spec section 4.1).
const express = require('express');
const {sendJson, problem, handle} = require('../http/problem');
const {parseListParams, parseIncludeDeleted} = require('./params');

const {ROW_COLUMNS: COLUMNS} = require('./response');
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

// The search term as an FTS5 phrase: the trigram index answers it (a LIKE with
// ESCAPE would bypass the index) and folds case for all of Unicode, not ASCII only.
function phrase(s) {
  return `"${s.replace(/"/g, '""')}"`;
}

function sendProblem(res, p) {
  const extra = p.errors ? {errors: p.errors} : {};
  return problem(res, p.status, p.detail, extra);
}

function publishedAtMs(row) {
  const ms = Date.parse(JSON.parse(row.official).publishedAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function serversRouter({store, log, view}) {
  const router = express.Router();

  router.get('/servers', handle(log, 'Failed to list servers', async (req, res) => {
    const parsed = parseListParams(req.query);
    if (parsed.problem) return sendProblem(res, parsed.problem);
    const p = parsed.params;
    const where = [];
    const args = [];
    if (!p.includeDeleted) where.push(VISIBLE);
    if (p.updatedSince) { where.push('changed_at > ?'); args.push(p.updatedSince); }
    if (p.search) { where.push('name IN (SELECT name FROM names WHERE id IN (SELECT rowid FROM names_fts WHERE names_fts MATCH ?))'); args.push(phrase(p.search)); }
    if (p.version === 'latest') where.push("json_extract(official, '$.isLatest') = 1");
    else if (p.version !== null) { where.push('version = ?'); args.push(p.version); }
    if (p.cursor !== null) {
      const c = decodeCursor(p.cursor);
      if (!c) return problem(res, 400, 'Invalid cursor');
      where.push('(name, version) > (?, ?)');
      args.push(c.name, c.version);
    }
    const sql = `SELECT ${COLUMNS} FROM records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name, version LIMIT ?`;
    // One row more than the page: nextCursor only when more records follow.
    const rows = await store.read(sql, [...args, p.limit + 1]);
    const more = rows.length > p.limit;
    if (more) rows.pop();
    const servers = await Promise.all(rows.map((r) => view(r, req)));
    const metadata = {};
    if (more) {
      const last = rows[rows.length - 1];
      metadata.nextCursor = encodeCursor(last.name, last.version);
    }
    metadata.count = servers.length;
    sendJson(res, 200, {servers, metadata});
  }));

  router.get('/servers/:name/versions', handle(log, 'Failed to get server versions', async (req, res) => {
    const inc = parseIncludeDeleted(req.query);
    if (inc.problem) return sendProblem(res, inc.problem);
    const rows = await store.read(
      `SELECT ${COLUMNS} FROM records WHERE name = ? ${inc.includeDeleted ? '' : `AND ${VISIBLE}`}`, [req.params.name]);
    if (!rows.length) return problem(res, 404, 'Server not found');
    const keyed = rows.map((r) => ({r, t: publishedAtMs(r)}));
    keyed.sort((a, b) => (b.t - a.t) || (a.r.version < b.r.version ? -1 : a.r.version > b.r.version ? 1 : 0));
    rows.splice(0, rows.length, ...keyed.map((k) => k.r));
    const servers = await Promise.all(rows.map((r) => view(r, req)));
    sendJson(res, 200, {servers, metadata: {count: servers.length}});
  }));

  router.get('/servers/:name/versions/:version', handle(log, 'Failed to get server details', async (req, res) => {
    const inc = parseIncludeDeleted(req.query);
    if (inc.problem) return sendProblem(res, inc.problem);
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

module.exports = {serversRouter, encodeCursor, decodeCursor};
