'use strict';
// The registry client the commands share: requests with fetch, problem+json
// refusals as "METHOD path: status title: detail", the private key from a file or
// COUNTINGHOUSE_REGISTRY_PRIVATE_KEY, and the dns-style exchange (spec 10.2).
// Neither the key nor a token is ever put in a message.
const fs = require('fs');
const {signTimestamp} = require('./sign');

const X = '/v0.1/x/io.github.mchen6/countinghouse-registry';
const KEY_ENV = 'COUNTINGHOUSE_REGISTRY_PRIVATE_KEY';

// exitCode 1: the command found problems (or was refused); 2: it cannot run.
class CliError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

// One huma error entry as a line: a string as is, {location, message}, or the
// entry itself when it carries no message.
function errorLine(e) {
  if (typeof e === 'string') return e;
  const hasMessage = e && typeof e.message === 'string';
  const text = hasMessage ? e.message : JSON.stringify(e);
  return e && typeof e.location === 'string' && hasMessage ? `${e.location}: ${text}` : text;
}

// A refusal from the registry, with its status and the one line describing it.
class ApiError extends CliError {
  constructor(method, path, status, body) {
    const b = body && typeof body === 'object' ? body : {};
    const title = typeof b.title === 'string' ? b.title : `HTTP ${status}`;
    const detail = typeof b.detail === 'string' ? b.detail : '';
    // The validation problems behind a 422, one line each: huma's errors, or
    // the validator's issues (errors only).
    const issues = Array.isArray(b.errors) ? b.errors.map(errorLine)
      : Array.isArray(b.issues) ? b.issues.filter((i) => i.severity === 'error').map((i) => `${i.path || '(document)'}: ${i.message}`) : [];
    super(1, `${method} ${path}: ${status} ${title}${detail ? `: ${detail}` : ''}${issues.map((l) => `\n  ${l}`).join('')}`);
    this.method = method;
    this.path = path;
    this.status = status;
    this.summary = `${status} ${title}${detail ? `: ${detail}` : ''}`;
    this.issues = issues;
  }
}

const enc = encodeURIComponent;
// name@version in a path, and the record endpoint (8.4), spelled once.
const entryPath = (name, version) => `${enc(name)}/versions/${enc(version)}`;
const recordPath = (name, version) => `${X}/records/${entryPath(name, version)}`;

function checkRegistry(registry) {
  if (typeof registry !== 'string' || !/^https?:\/\/[^/]/.test(registry)) throw new CliError(1, `--registry must be an http(s) base URL, not ${JSON.stringify(registry)}`);
}

function createClient({registry, fetch: doFetch = globalThis.fetch}) {
  checkRegistry(registry);
  const base = registry.replace(/\/+$/, '');
  async function request(method, path, {token, body} = {}) {
    const headers = {accept: 'application/json, application/problem+json'};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // A failure to send, or to read the whole answer (a reset mid-body), is one
    // case: exit 2, naming the cause, never the body.
    let res;
    let text;
    try {
      res = await doFetch(`${base}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
      text = await res.text();
    } catch (err) {
      throw new CliError(2, `${method} ${base}${path}: the registry could not be reached (${(err && err.cause && err.cause.code) || (err && err.message)})`);
    }
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (res.status >= 400) throw new ApiError(method, path, res.status, parsed);
    return {status: res.status, body: parsed};
  }
  return {request, base};
}

// The private key as hex: from the file given, or the environment variable; never both.
function loadPrivateKey({keyFile, env = process.env}) {
  const fromEnv = env[KEY_ENV];
  if (keyFile && fromEnv) throw new CliError(1, `give the key once: --key or ${KEY_ENV}, not both`);
  if (!keyFile && !fromEnv) throw new CliError(1, `needs a private key: --key <file> or ${KEY_ENV} (hex, as mcp-publisher takes it)`);
  if (fromEnv) return fromEnv.trim();
  try {
    return fs.readFileSync(keyFile, 'utf8').trim();
  } catch (err) {
    throw new CliError(1, `cannot read the key file ${keyFile} (${err.code || err.name})`);
  }
}

// -> the registry token. Errors name the step and the registry's answer only.
async function exchange(client, {domain, privateKeyHex, algorithm = 'ed25519'}) {
  if (typeof domain !== 'string' || domain === '') throw new CliError(1, 'needs --domain: the domain your key is configured for');
  let signed;
  try {
    signed = signTimestamp(privateKeyHex, algorithm, new Date(), {millis: true});
  } catch (err) {
    throw new CliError(1, `cannot sign with the key: ${err.message}`);
  }
  const {body} = await client.request('POST', '/v0.1/auth/dns', {body: {domain, ...signed}});
  if (!body || typeof body.registry_token !== 'string') throw new CliError(1, 'POST /v0.1/auth/dns: the registry answered without a token');
  return body.registry_token;
}

// A signed-in client for one command's calls: call(method, path, body). Tokens
// last 5 minutes (10.3), so a call answered 401 signs in again once and is
// retried (a long register run outlives its first token).
async function signIn({registry, domain, keyFile, algorithm, env, fetch}) {
  const client = createClient({registry, fetch});
  const privateKeyHex = loadPrivateKey({keyFile, env});
  let token = await exchange(client, {domain, privateKeyHex, algorithm});
  const call = async (method, path, body) => {
    try {
      return await client.request(method, path, {token, body});
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      token = await exchange(client, {domain, privateKeyHex, algorithm});
      return client.request(method, path, {token, body});
    }
  };
  return {...client, call};
}

module.exports = {createClient, exchange, signIn, loadPrivateKey, checkRegistry, CliError, ApiError, X, KEY_ENV, enc, entryPath, recordPath};
