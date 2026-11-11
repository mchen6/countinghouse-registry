'use strict';
// The registry's auth for createApp (spec section 10): the exchange routes and
// require(perm) for the write routes. A token's claims are the whole actor: a
// key removed from config stops new exchanges at the next start, and tokens
// already issued stay valid until they expire (10.1). Logs carry key
// fingerprints, key names and instance ids, never a token, signature or key.
const express = require('express');
const {sendJson, problem} = require('../http/problem');
const {authFor} = require('./permissions');
const {verifyJwt} = require('./jwt');
const {createExchanges, ExchangeError} = require('./exchange');
const {createReplayCache} = require('./replay');
const {createRateLimiter} = require('./rate-limit');

const X = '/x/io.github.mchen6/countinghouse-registry';
const UNSUPPORTED = ['github-at', 'github-oidc', 'oidc', 'none'];
const BEARER = /^Bearer ([A-Za-z0-9_.-]+)$/;

function actorOf(claims) {
  if (claims.kind === 'publisher') {
    return {kind: 'publisher', sub: claims.sub, namespaces: claims.perm.namespaces, operate: claims.perm.operate};
  }
  return {kind: 'instance', sub: claims.sub, instance: claims.perm.instance};
}

// -> {require(perm), router}. Throws ConfigError for a key that does not parse.
function createAuth({config, secret, log, now = () => new Date(), replay, limiter}) {
  const ms = () => now().getTime();
  const exchanges = createExchanges({config, secret, now, replay: replay || createReplayCache({now: ms})});
  const limit = limiter || createRateLimiter({now: ms});

  const getActor = (req) => {
    const m = BEARER.exec(req.get('authorization') || '');
    const claims = m && verifyJwt(m[1], secret, now());
    return claims ? actorOf(claims) : null;
  };

  // Every exchange request counts, before its body is read. req.ip is the
  // socket address, or the forwarded one with listen.trustProxy (app.js).
  const rateLimited = (req, res, next) => {
    const {ok, retryAfterSec} = limit.take(req.ip || 'unknown');
    if (ok) return next();
    res.setHeader('Retry-After', String(retryAfterSec));
    return problem(res, 429, `Too many authentication requests; retry after ${retryAfterSec} seconds`);
  };

  const run = (fn) => (req, res) => {
    try {
      const {response, log: fields} = fn(req.body);
      log.info('auth.exchange', 'issued a registry token', fields);
      sendJson(res, 200, response);
    } catch (err) {
      if (!(err instanceof ExchangeError)) throw err;
      log.warn('auth.exchange.refused', 'refused a token exchange', {...err.fields, reason: err.reason});
      problem(res, err.status, err.detail, {errors: err.errors});
    }
  };

  const json = express.json({limit: '1mb', strict: false});
  const router = express.Router();
  for (const method of ['dns', 'http']) {
    router.post(`/auth/${method}`, rateLimited, json, run((body) => exchanges.domain(method, body)));
  }
  router.post(`${X}/auth/instance`, rateLimited, json, run((body) => exchanges.instance(body)));
  for (const method of UNSUPPORTED) {
    router.post(`/auth/${method}`, (req, res) => problem(res, 404,
      `This registry does not offer ${method} authentication; use dns or http (mcp-publisher login dns|http) with a key configured for your domain`));
  }

  return {...authFor(getActor), router};
}

module.exports = {createAuth};
