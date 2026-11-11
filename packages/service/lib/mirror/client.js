'use strict';
// The mirror's HTTP client for the official registry (spec section 6.1, 6.4):
// GET /v0.1/servers?limit=100&include_deleted=true, one request at a time, gzip,
// the decided User-Agent. On a network error, a 5xx or a 429 it waits (Retry-After
// when given, otherwise exponential backoff with full jitter from 5 s) and tries
// again, until it has waited maxDelayMs in total; then it throws an UpstreamError.
// Logs and errors carry the status code only, never the body.

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const BASE_DELAY_MS = 5000;
const MIN_DELAY_MS = 250; // a jitter draw near 0 must not become a tight loop
const FETCH_TIMEOUT_MS = 30000;
const VERSION_TIMEOUT_MS = 10000;

// A sleep that ends early, rejecting, when the signal aborts.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new UpstreamError('aborted'));
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new UpstreamError('aborted')); };
    if (signal) signal.addEventListener('abort', onAbort, {once: true});
  });
}

async function drain(res) {
  try {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    else if (typeof res.text === 'function') await res.text();
  } catch {
    // nothing to do: the body is unwanted either way
  }
}

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

function createUpstreamClient({baseUrl, fetch = globalThis.fetch, userAgent, sleep = abortableSleep, random = Math.random, maxDelayMs}) {
  const headers = {'User-Agent': userAgent, 'Accept': 'application/json', 'Accept-Encoding': 'gzip'};

  // One fetch, bounded by a timeout and by the caller's signal.
  async function fetchOnce(url, signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await fetch(url, {headers, signal: combined});
    } catch {
      if (signal && signal.aborted) throw new UpstreamError('aborted');
      throw new UpstreamError('network');
    }
  }

  async function bodyJson(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamError('bad-page', 200);
    }
  }

  async function getJson(url, signal) {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      let res = null;
      let err;
      try {
        res = await fetchOnce(url, signal, FETCH_TIMEOUT_MS);
      } catch (e) {
        if (e.code === 'aborted') throw e;
        err = e;
      }
      if (res && res.status === 200) return bodyJson(res);
      if (res) {
        await drain(res);
        if (res.status === 429) err = new UpstreamError('http-429', 429);
        else if (res.status >= 500) err = new UpstreamError('http-5xx', res.status);
        else if (res.status >= 400) throw new UpstreamError('http-4xx', res.status);
        else throw new UpstreamError('bad-page', res.status);
      }
      const drawn = (res && retryAfterMs(res)) ?? Math.floor(random() * Math.min(maxDelayMs, BASE_DELAY_MS * 2 ** attempt));
      const delay = Math.max(MIN_DELAY_MS, drawn);
      if (waited + delay > maxDelayMs) throw err;
      await sleep(delay, signal);
      waited += delay;
    }
  }

  // Relative to the base URL's path, so a registry served under a path prefix works.
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const endpoint = (p) => new URL(p, base);

  async function page({cursor = null, updatedSince = null, signal = null} = {}) {
    const u = endpoint('v0.1/servers');
    u.searchParams.set('limit', '100');
    u.searchParams.set('include_deleted', 'true');
    if (cursor) u.searchParams.set('cursor', cursor);
    if (updatedSince) u.searchParams.set('updated_since', updatedSince);
    const body = await getJson(u.toString(), signal);
    if (!validPage(body)) throw new UpstreamError('bad-page', 200);
    return {servers: body.servers, nextCursor: body.metadata.nextCursor || null};
  }

  // Informational only: one attempt, a short timeout, null on any failure, so it
  // never holds up a sync.
  async function version({signal = null} = {}) {
    try {
      const res = await fetchOnce(endpoint('v0.1/version').toString(), signal, VERSION_TIMEOUT_MS);
      if (res.status !== 200) { await drain(res); return null; }
      const body = await bodyJson(res);
      return body && typeof body.version === 'string' ? body.version : null;
    } catch {
      return null;
    }
  }

  return {page, version};
}

module.exports = {createUpstreamClient, UpstreamError};
