'use strict';
// The enable routes under /v0.1/x/io.github.mchen6/countinghouse-registry (and
// /v0/x/...), spec sections 9.3 and 9.4. No CORS headers.
//   PUT|DELETE instances/{instance}/enabled/{name}/versions/{version}  operator
//   GET        instances/{instance}/enabled?since=&limit=              that instance (its poll),
//                                                                      or an operator (with results)
//   POST       instances/{instance}/results                            that instance
// Bodies are at most 1 MiB (app.js answers 413).
const express = require('express');
const {sendJson, problem, handle} = require('../http/problem');
const {allows} = require('../auth/permissions');
const {enableEntry, disableEntry, postResult, pollEnabled, operatorEnabled, EnableError} = require('./enable');

const DECIMAL = /^(0|[1-9][0-9]*)$/;

const guarded = (log, failDetail, fn) => handle(log, failDetail, async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof EnableError) return problem(res, err.status, err.detail, err.extra);
    throw err;
  }
});

// -> {since, limit} or an errors list, as upstream answers query problems.
function pollParams(query) {
  const errors = [];
  let since = 0;
  let limit = 100;
  if (query.since !== undefined) {
    if (typeof query.since === 'string' && DECIMAL.test(query.since) && query.since.length <= 18) since = Number(query.since);
    else errors.push({message: 'expected a decimal sequence value (the nextSince of the previous poll)', location: 'query.since', value: query.since});
  }
  if (query.limit !== undefined) {
    const n = typeof query.limit === 'string' && /^[0-9]+$/.test(query.limit) ? Number(query.limit) : NaN;
    if (n >= 1 && n <= 100) limit = n;
    else errors.push({message: 'expected an integer from 1 to 100', location: 'query.limit', value: query.limit});
  }
  return errors.length ? {errors} : {since, limit};
}

function enableRouter({store, config, log, auth, now}) {
  const router = express.Router();
  const json = express.json({limit: '1mb', strict: false});
  const known = new Set((config.instances || []).map((i) => i.instance));
  const configured = (req, res, next) => (known.has(req.params.instance) ? next()
    : problem(res, 404, `No instance ${req.params.instance} is configured`));
  const operate = auth.require('operate');
  const asInstance = auth.require((req) => `instance:${req.params.instance}`);
  const entryPath = '/instances/:instance/enabled/:name/versions/:version';

  router.put(entryPath, operate, configured, json, guarded(log, 'Failed to enable the entry', async (req, res) => {
    const {instance, name, version} = req.params;
    sendJson(res, 200, await enableEntry(store, {instance, name, version, body: req.body, actor: req.actor, now: now()}));
  }));

  router.delete(entryPath, operate, configured, guarded(log, 'Failed to disable the entry', async (req, res) => {
    const {instance, name, version} = req.params;
    sendJson(res, 200, await disableEntry(store, {instance, name, version, actor: req.actor, now: now()}));
  }));

  // The instance's poll, or the operator's listing of the same entries.
  router.get('/instances/:instance/enabled', (req, res, next) => {
    const actor = auth.actor(req);
    if (actor && allows(actor, 'operate')) return operate(req, res, next);
    return asInstance(req, res, next);
  }, configured, guarded(log, 'Failed to list the enabled entries', async (req, res) => {
    const p = pollParams(req.query);
    if (p.errors) return problem(res, 422, 'validation failed', {errors: p.errors});
    const forOperator = allows(req.actor, 'operate');
    const out = forOperator ? await operatorEnabled(store, req.params.instance, p.since, p.limit)
      : await pollEnabled(store, req.params.instance, p.since, p.limit);
    return sendJson(res, 200, {items: out.items, nextSince: out.nextSince});
  }));

  router.post('/instances/:instance/results', configured, asInstance, json, guarded(log, 'Failed to record the result', async (req, res) => {
    sendJson(res, 200, await postResult(store, {instance: req.params.instance, body: req.body, now: now()}));
  }));

  return router;
}

module.exports = {enableRouter, pollParams};
