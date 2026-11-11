'use strict';
// The mirror's HTTP client for the official registry (spec section 6.1, 6.4):
// GET /v0.1/servers?limit=100&include_deleted=true, one request at a time, gzip,
// the decided User-Agent. On a network error, a 5xx or a 429 it waits (Retry-After
// when given, otherwise exponential backoff with full jitter from 5 s) and tries
// again, until it has waited maxDelayMs in total; then it throws an UpstreamError.
// Logs and errors carry the status code only, never the body.

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const BASE_DELAY_MS = 5000;

class UpstreamError extends Error {
  constructor(code, status = null) {
    super(`upstream ${code}${status ? ` (${status})` : ''}`);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
  }
}

function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (v === null) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function validPage(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.servers) || !body.metadata || typeof body.metadata !== 'object') return false;
  return body.servers.every((r) => r && r.server && typeof r.server.name === 'string' && typeof r.server.version === 'string' &&
    r._meta && r._meta[OFFICIAL] && typeof r._meta[OFFICIAL] === 'object');
}

function createUpstreamClient({baseUrl, fetch = globalThis.fetch, userAgent, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random, maxDelayMs}) {
  const headers = {'User-Agent': userAgent, 'Accept': 'application/json', 'Accept-Encoding': 'gzip'};

  async function getJson(url) {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      let res = null;
      let err = null;
      try {
        res = await fetch(url, {headers});
      } catch (e) {
        err = new UpstreamError('network');
      }
      if (res && res.status === 200) {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new UpstreamError('bad-page', 200);
        }
      }
      if (res && res.status !== 429 && res.status < 500) throw new UpstreamError('http-4xx', res.status);
      if (res) err = new UpstreamError(res.status === 429 ? 'http-429' : 'http-5xx', res.status);
      const delay = (res && retryAfterMs(res)) ?? Math.floor(random() * Math.min(maxDelayMs, BASE_DELAY_MS * 2 ** attempt));
      if (waited + delay > maxDelayMs) throw err;
      await sleep(delay);
      waited += delay;
    }
  }

  async function page({cursor = null, updatedSince = null} = {}) {
    const u = new URL('/v0.1/servers', baseUrl);
    u.searchParams.set('limit', '100');
    u.searchParams.set('include_deleted', 'true');
    if (cursor) u.searchParams.set('cursor', cursor);
    if (updatedSince) u.searchParams.set('updated_since', updatedSince);
    const body = await getJson(u.toString());
    if (!validPage(body)) throw new UpstreamError('bad-page', 200);
    return {servers: body.servers, nextCursor: body.metadata.nextCursor || null};
  }

  async function version() {
    try {
      const body = await getJson(new URL('/v0.1/version', baseUrl).toString());
      return body && typeof body.version === 'string' ? body.version : null;
    } catch {
      return null;
    }
  }

  return {page, version};
}

module.exports = {createUpstreamClient, UpstreamError};
