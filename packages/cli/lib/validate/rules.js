'use strict';
// The semantic rules of upstream's internal/validators/validators.go and utils.go
// at 7e8fa024, one function per rule, in upstream's order, each issue carrying
// upstream's rule id as `reference` and upstream's message. Go reads a missing
// string as "" and a missing list as empty; so do these (str, list).
const {goParseURL} = require('./go-url');

const issue = (p, message, reference) => ({type: 'semantic', path: p, message, severity: 'error', reference});
const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
// Go's %q for a string (close to JSON for the printable ASCII these messages hold).
const q = (s) => JSON.stringify(s);
// Go's %v of a []string.
const goList = (a) => `[${a.join(' ')}]`;

// strings.TrimSpace: Unicode White_Space as Go's unicode.IsSpace.
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const trimSpace = (s) => s.replace(new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'g'), '');

// --- server name (parseServerName)
const NS = '[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]';
const PART = '[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]';
const namespaceRe = new RegExp(`^${NS}$`);
const namePartRe = new RegExp(`^${PART}$`);
const serverNameRe = new RegExp(`^${NS}/${PART}$`);

function serverNameError(name) {
  if (name === '') return 'server name is required and must be a string';
  if (!name.includes('/')) return "server name must be in format 'dns-namespace/name' (e.g., 'com.example.api/server')";
  if (name.split('/').length - 1 > 1) return 'server name cannot contain multiple slashes';
  const [ns, part] = [name.slice(0, name.indexOf('/')), name.slice(name.indexOf('/') + 1)];
  if (!ns || !part) return "server name must be in format 'dns-namespace/name' with non-empty namespace and name parts";
  if (!serverNameRe.test(name)) {
    if (!namespaceRe.test(ns)) return `server name format is invalid: namespace '${ns}' is invalid. Namespace must start and end with alphanumeric characters, and may contain dots and hyphens in the middle`;
    if (!namePartRe.test(part)) return `server name format is invalid: name '${part}' is invalid. Name must start and end with alphanumeric characters, and may contain dots, underscores, and hyphens in the middle`;
    return `server name format is invalid: invalid format for '${name}'`;
  }
  return null;
}

// --- versions (validateVersion, looksLikeVersionRange). RE2's \s is [\t\n\f\r ].
const S = '[\\t\\n\\f\\r ]';
const V = 'v?\\d+(?:\\.\\d+){0,3}(?:-[0-9A-Za-z.-]+)?';
const comparatorRangeRe = new RegExp(`^${S}*(?:\\^|~|>=|<=|>|<|=)${S}*${V}${S}*$`);
const hyphenRangeRe = new RegExp(`^${S}*${V}${S}-${S}*${V}${S}*$`);
const orRangeRe = new RegExp(`^${S}*(?:${V}${S}*)(?:\\|\\|${S}*${V}${S}*)+$`);
const dottedVersionLikeRe = new RegExp(`^${S}*(?:v?\\d+|x|X|\\*)(?:\\.(?:\\d+|x|X|\\*)){1,2}(?:-[0-9A-Za-z.-]+)?${S}*$`);

function looksLikeVersionRange(version) {
  const t = trimSpace(version);
  if (t === '') return false;
  if (comparatorRangeRe.test(t) || hyphenRangeRe.test(t) || orRangeRe.test(t)) return true;
  if (dottedVersionLikeRe.test(t)) return /[xX*]/.test(t);
  return false;
}

function validateVersion(p, version) {
  if (version === 'latest') return [issue(p, "version string 'latest' is reserved and cannot be used", 'reserved-version-string')];
  if (looksLikeVersionRange(version)) return [issue(p, `version must be a specific version, not a range: ${q(version)}`, 'version-looks-like-range')];
  return [];
}

// --- repository (validateRepository, IsValidRepositoryURL, IsValidSubfolderPath)
const githubURLRe = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/;
const gitlabURLRe = /^https?:\/\/(www\.)?gitlab\.com\/[\w.-]+(\/[\w.-]+)+\/?$/;

function isValidRepositoryURL(source, url) {
  if (source === 'github') return githubURLRe.test(url);
  if (source === 'gitlab') return gitlabURLRe.test(url) && !`${url}/`.includes('/-/');
  return false;
}

function isValidSubfolderPath(p) {
  if (p === '') return true;
  if (p.startsWith('/') || p.endsWith('/')) return false;
  if (!/^[a-zA-Z0-9\-_./]+$/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function validateRepository(repo) {
  const r = obj(repo);
  if (!r) return [];
  const out = [];
  const url = str(r.url);
  const source = str(r.source);
  if (url === '') out.push(issue('repository.url', 'repository url is required when repository is provided', 'repository-url-required'));
  if (source === '') out.push(issue('repository.source', 'repository source is required when repository is provided', 'repository-source-required'));
  if (out.length) return out;
  if (!isValidRepositoryURL(source, url)) out.push(issue('repository.url', `invalid repository URL: ${url}`, 'invalid-repository-url'));
  const sub = str(r.subfolder);
  if (sub !== '' && !isValidSubfolderPath(sub)) out.push(issue('repository.subfolder', `invalid subfolder path: ${sub}`, 'invalid-subfolder-path'));
  return out;
}

// --- website, title, icons
function validateWebsiteURL(website) {
  const url = str(website);
  if (url === '') return [];
  const u = goParseURL(url);
  if (u.error) return [issue('websiteUrl', `invalid websiteUrl: ${u.error}`, 'invalid-website-url')];
  const out = [];
  if (!u.scheme) out.push(issue('websiteUrl', `websiteUrl must be absolute (include scheme): ${url}`, 'website-url-must-be-absolute'));
  if (u.scheme !== 'https') out.push(issue('websiteUrl', `websiteUrl must use https scheme: ${url}`, 'website-url-invalid-scheme'));
  const bad = /["'<> \t\n\r]/.exec(url);
  if (bad) {
    // Go's %q of a byte prints it as a quoted character, its position is in bytes.
    const pos = Buffer.byteLength(url.slice(0, bad.index));
    out.push(issue('websiteUrl', `websiteUrl contains an invalid character ${goRune(bad[0])} at position ${pos}: ${url}`, 'website-url-invalid-characters'));
  }
  return out;
}

function goRune(ch) {
  const named = {'\t': "'\\t'", '\n': "'\\n'", '\r': "'\\r'", "'": "'\\''"};
  return named[ch] || `'${ch}'`;
}

function validateTitle(title) {
  const t = str(title);
  if (t === '' || trimSpace(t) !== '') return [];
  return [issue('title', 'title cannot be only whitespace', 'title-whitespace-only')];
}

function validateIcons(icons) {
  const out = [];
  list(icons).forEach((icon, i) => {
    const p = `icons[${i}].src`;
    const src = str(obj(icon) ? icon.src : '');
    const u = goParseURL(src);
    if (u.error) { out.push(issue(p, `invalid icon src URL: ${u.error}`, 'icon-src-invalid-url')); return; }
    if (!u.scheme) out.push(issue(p, `icon src must be an absolute URL (include scheme): ${src}`, 'icon-src-not-absolute'));
    if (u.scheme !== 'https') out.push(issue(p, `icon src must use https scheme (got ${u.scheme}): ${src}`, 'icon-src-invalid-scheme'));
  });
  return out;
}

// --- URLs with templates (utils.go)
function extractTemplateVariables(url) {
  return [...url.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

function replaceTemplateVariables(raw) {
  let r = raw;
  for (const [k, v] of Object.entries({'{host}': 'example.com', '{port}': '8080', '{path}': 'api', '{protocol}': 'http', '{scheme}': 'http'})) r = r.split(k).join(v);
  r = r.replace(/:(\{[^}]+\})(\/|$)/g, ':8080$2');
  return r.replace(/\{[^}]+\}/g, 'placeholder');
}

function isValidURL(raw) {
  const u = goParseURL(replaceTemplateVariables(raw));
  if (u.error) return false;
  return (u.scheme === 'http' || u.scheme === 'https') && u.host !== '';
}

function isValidRemoteURL(raw) {
  if (!isValidURL(raw)) return false;
  const u = goParseURL(replaceTemplateVariables(raw));
  if (u.error) return false;
  const h = u.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost')) return false;
  return u.scheme === 'https';
}

function isValidTemplatedURL(raw, available) {
  if (!isValidURL(raw)) return false;
  const vars = extractTemplateVariables(raw);
  const set = new Set(available);
  return vars.every((v) => set.has(v));
}

// --- arguments (validateArgument and its helpers)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'string';

function validateArgument(p, arg) {
  const a = obj(arg) || {};
  const type = str(a.type);
  if (type === 'named') {
    const name = str(a.name);
    const out = [];
    if (name === '') out.push(issue(`${p}.name`, 'named argument name is required', 'named-argument-name-required'));
    else if (/[<> $]/.test(name)) out.push(issue(`${p}.name`, `invalid named argument name format: ${name}`, 'invalid-named-argument-name'));
    // Upstream checks these whatever the name check found (an empty name prefixes every value).
    const value = str(a.value);
    const def = str(a.default);
    if (value !== '' && value.startsWith(name)) {
      out.push(issue(`${p}.value`, `argument value cannot start with the argument name: value starts with argument name '${name}': ${value}`, 'argument-value-starts-with-name'));
    }
    if (def !== '' && def.startsWith(name)) {
      out.push(issue(`${p}.default`, `argument default cannot start with the argument name: default starts with argument name '${name}': ${def}`, 'argument-default-starts-with-name'));
    }
    return out;
  }
  if (type === 'positional') {
    if (has(a, 'value') || has(a, 'valueHint')) return [];
    return [issue(p, 'positional argument must provide a value or a valueHint', 'positional-argument-value-or-hint-required')];
  }
  return [issue(`${p}.type`, `argument type must be 'positional' or 'named': ${q(type)}`, 'invalid-argument-type')];
}

function collectAvailableVariables(pkg) {
  const vars = [];
  for (const env of list(pkg.environmentVariables)) vars.push(str(obj(env) ? env.name : ''));
  for (const key of ['runtimeArguments', 'packageArguments']) {
    for (const arg of list(pkg[key])) {
      const a = obj(arg) || {};
      if (str(a.name) !== '') vars.push(a.name);
      if (str(a.valueHint) !== '') vars.push(a.valueHint);
    }
  }
  return vars;
}

function validatePackageTransport(p, transport, available) {
  const t = obj(transport) || {};
  const type = str(t.type);
  const url = str(t.url);
  if (type === 'stdio') {
    return url === '' ? [] : [issue(`${p}.url`, `url must be empty for ${type} transport type, got: ${url}`, 'stdio-transport-url-not-empty')];
  }
  if (type === 'streamable-http' || type === 'sse') {
    if (url === '') return [issue(`${p}.url`, `url is required for ${type} transport type`, 'streamable-transport-url-required')];
    if (!isValidTemplatedURL(url, available)) {
      const message = extractTemplateVariables(url).length
        ? `invalid package transport URL: template variables in URL ${url} reference undefined variables. Available variables: ${goList(available)}`
        : `invalid package transport URL: ${url}`;
      return [issue(`${p}.url`, message, 'invalid-templated-url')];
    }
    return [];
  }
  return [issue(`${p}.type`, `unsupported transport type: ${type}`, 'unsupported-transport-type')];
}

function validatePackage(p, pkg) {
  const k = obj(pkg) || {};
  const out = [];
  if (str(k.identifier).includes(' ')) out.push(issue(`${p}.identifier`, 'package name cannot contain spaces', 'package-name-has-spaces'));
  out.push(...validateVersion(`${p}.version`, str(k.version)));
  list(k.runtimeArguments).forEach((a, i) => out.push(...validateArgument(`${p}.runtimeArguments[${i}]`, a)));
  list(k.packageArguments).forEach((a, i) => out.push(...validateArgument(`${p}.packageArguments[${i}]`, a)));
  out.push(...validatePackageTransport(`${p}.transport`, k.transport, collectAvailableVariables(k)));
  return out;
}

function validateRemote(p, remote) {
  const t = obj(remote) || {};
  const type = str(t.type);
  const url = str(t.url);
  if (type !== 'streamable-http' && type !== 'sse') {
    return [issue(`${p}.type`, `unsupported transport type for remotes: ${type} (only streamable-http and sse are supported)`, 'unsupported-remote-transport-type')];
  }
  const out = [];
  if (url === '') out.push(issue(`${p}.url`, `url is required for ${type} transport type`, 'remote-transport-url-required'));
  else if (!isValidRemoteURL(url)) out.push(issue(`${p}.url`, `invalid remote URL: ${url}`, 'invalid-remote-url'));
  const available = Object.keys(obj(t.variables) || {}).filter((v) => v !== '');
  if (!isValidTemplatedURL(url, available)) {
    const message = extractTemplateVariables(url).length
      ? `invalid remote URL: template variables in URL ${url} reference undefined variables. Available variables: ${goList(available)}`
      : `invalid remote URL: ${url}`;
    out.push(issue(`${p}.url`, message, 'invalid-templated-url'));
  }
  return out;
}

// upstream ValidateServerJSON's semantic part, in its order.
function semanticIssues(doc) {
  const out = [];
  const nameError = serverNameError(str(doc.name));
  if (nameError) out.push(issue('name', nameError, 'invalid-server-name'));
  out.push(...validateVersion('version', str(doc.version)));
  out.push(...validateRepository(doc.repository));
  out.push(...validateWebsiteURL(doc.websiteUrl));
  out.push(...validateTitle(doc.title));
  out.push(...validateIcons(doc.icons));
  list(doc.packages).forEach((pkg, i) => out.push(...validatePackage(`packages[${i}]`, pkg)));
  list(doc.remotes).forEach((r, i) => out.push(...validateRemote(`remotes[${i}]`, r)));
  return out;
}

// The rule ids ported (validators.go at the pin).
const RULE_IDS = ['invalid-server-name', 'repository-url-required', 'repository-source-required', 'invalid-repository-url', 'invalid-subfolder-path',
  'invalid-website-url', 'website-url-must-be-absolute', 'website-url-invalid-scheme', 'website-url-invalid-characters', 'title-whitespace-only',
  'icon-src-invalid-url', 'icon-src-not-absolute', 'icon-src-invalid-scheme', 'package-name-has-spaces', 'reserved-version-string',
  'version-looks-like-range', 'positional-argument-value-or-hint-required', 'invalid-argument-type', 'named-argument-name-required',
  'invalid-named-argument-name', 'argument-value-starts-with-name', 'argument-default-starts-with-name', 'stdio-transport-url-not-empty',
  'streamable-transport-url-required', 'invalid-templated-url', 'unsupported-transport-type', 'remote-transport-url-required', 'invalid-remote-url',
  'unsupported-remote-transport-type'];

module.exports = {semanticIssues, RULE_IDS, goParseURL, trimSpace, isValidRepositoryURL};
