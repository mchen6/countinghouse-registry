'use strict';
// Upstream's publish-time rules at 7e8fa024 that need no network
// (internal/validators/validators.go ValidatePublishRequest, package.go and
// registries/*.go): the 4 KiB cap on publisher-provided, and for each package the
// checks each registry's validator makes before it fetches anything (identifier
// and version present, fileSha256 only for MCPB, the base-URL allow-lists, OCI's
// registry allow-list, MCPB's release-URL hosts). The ownership fetch that follows
// upstream is not ported (spec 7.5). Upstream stops at the first failing package;
// these report one issue per failing package, each the first check that package
// fails. Upstream returns plain errors here, so the rule ids are ours.
const {goJsonSize} = require('../go-json-size');
const {goParseURL} = require('./go-url');

const PUBLISHER_PROVIDED = 'io.modelcontextprotocol.registry/publisher-provided';
const MAX_PUBLISHER_PROVIDED = 4 * 1024;

const URLS = {
  npm: 'https://registry.npmjs.org', pypi: 'https://pypi.org', nuget: 'https://api.nuget.org/v3/index.json', cargo: 'https://crates.io'
};
const NAMES = {npm: 'NPM', pypi: 'PyPI', nuget: 'NuGet', cargo: 'Cargo'};

const issue = (p, message, reference) => ({type: 'registry', path: p, message, severity: 'error', reference});
const str = (v) => (typeof v === 'string' ? v : '');

// The _meta upstream keeps: only publisher-provided (ServerJSON.Meta is
// ServerMeta{PublisherProvided}); a _meta without it stays as {}. Not in place.
function reduceMeta(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !('_meta' in doc)) return doc;
  const meta = doc._meta;
  const kept = meta && typeof meta === 'object' && !Array.isArray(meta) && PUBLISHER_PROVIDED in meta ? {[PUBLISHER_PROVIDED]: meta[PUBLISHER_PROVIDED]} : {};
  return {...doc, _meta: kept};
}

function publisherProvidedIssues(doc) {
  const meta = doc._meta;
  const pp = meta && typeof meta === 'object' ? meta[PUBLISHER_PROVIDED] : undefined;
  if (pp === undefined || pp === null) return [];
  const size = goJsonSize(pp);
  if (size <= MAX_PUBLISHER_PROVIDED) return [];
  return [issue(`_meta.${PUBLISHER_PROVIDED}`, `_meta.${PUBLISHER_PROVIDED} extension exceeds 4KB limit (${size} bytes)`, 'publisher-provided-too-large')];
}

// npm, PyPI, NuGet and Cargo share one shape (registries/{npm,pypi,nuget,cargo}.go).
function baseURLPackage(type, pkg) {
  const base = str(pkg.registryBaseUrl) || URLS[type];
  const who = NAMES[type];
  const lower = type === 'cargo' ? 'cargo' : who;
  if (!str(pkg.identifier)) return [`package identifier is required for ${who} packages`, 'registry-identifier-required'];
  // NuGet checks its version after the base URL; the others before fileSha256.
  if (type !== 'nuget' && !str(pkg.version)) return [`package version is required for ${who} packages`, 'registry-version-required'];
  if (str(pkg.fileSha256)) {
    const tail = type === 'npm' ? '' : ' - this is only for MCPB packages';
    return [`${lower} packages must not have 'fileSha256' field${tail}`, 'registry-file-sha256-not-allowed'];
  }
  if (base !== URLS[type]) {
    return [`registry type and base URL do not match: '${base}' is not valid for registry type '${type}'. Expected: ${URLS[type]}`, 'registry-base-url-mismatch'];
  }
  if (type === 'nuget' && !str(pkg.version)) return [`package version is required for ${who} packages`, 'registry-version-required'];
  return null;
}

// go-containerregistry's name.ParseReference with default (weak) options, as at
// v0.22.1 (8a72a424fdecb4caa14f2d525e5d2503331442b5, upstream's go.mod pin):
// pkg/name/ref.go, tag.go, repository.go, registry.go, digest.go, check.go.
// -> {registry} (RegistryStr) or {error}.
const TAG_CHARS = /^[a-z0-9_.A-Z-]*$/;
const REPOSITORY_CHARS = /^[a-z0-9_./-]*$/;
const runes = (s) => [...s].length;

class BadName extends Error {}

function checkElement(what, element, chars, min, max) {
  const n = runes(element);
  if (n < min || n > max) throw new BadName(`${what} must be between ${min} and ${max} characters in length: ${element}`);
  if (!chars.test(element)) throw new BadName(`${what} can only contain the characters of ${chars.source}: ${element}`);
}

function newRegistry(name) {
  // checkRegistry: a valid RFC 3986 authority, as url.Parse("//" + name) reads it.
  const u = goParseURL(`//${name}`);
  if (u.error || u.host !== name) throw new BadName(`registries must be valid RFC 3986 URI authorities: ${name}`);
  if (name === '' || name === 'docker.io') return 'index.docker.io';
  return name;
}

function newRepository(name) {
  if (name.length === 0) throw new BadName('a repository name must be specified');
  let registry = '';
  let repo = name;
  const slash = name.indexOf('/');
  if (slash >= 0) {
    const maybe = name.slice(0, slash);
    if (maybe === 'localhost' || /[.:]/.test(maybe)) { registry = maybe; repo = name.slice(slash + 1); }
  }
  checkElement('repository', repo, REPOSITORY_CHARS, 1, 255);
  return newRegistry(registry);
}

function newTag(name) {
  const parts = name.split(':');
  let base = name;
  if (parts.length > 1 && !parts[parts.length - 1].includes('/')) {
    const tag = parts[parts.length - 1];
    base = parts.slice(0, -1).join(':');
    if (tag === '') throw new BadName(`${name} must specify a tag name after the colon`);
    checkElement('tag', tag, TAG_CHARS, 1, 128);
  }
  return newRepository(base);
}

// opencontainers/go-digest Validate, for the algorithms it registers.
const DIGEST = /^(sha256:[a-f0-9]{64}|sha384:[a-f0-9]{96}|sha512:[a-f0-9]{128})$/;

function newDigest(name) {
  const parts = name.split('@');
  if (parts.length !== 2) throw new BadName(`a digest must contain exactly one '@' separator (e.g. registry/repository@digest) saw: ${name}`);
  if (!DIGEST.test(parts[1])) throw new BadName(`invalid digest: ${parts[1]}`);
  try { return newTag(parts[0]); } catch (err) { if (!(err instanceof BadName)) throw err; }
  return newRepository(parts[0]);
}

function ociRegistry(ref) {
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    return {error: `image reference must not contain a URL scheme (http:// or https://): ${ref}; to connect to a registry over plain HTTP, use name.Insecure`};
  }
  for (const parse of [newTag, newDigest]) {
    try { return {registry: parse(ref)}; } catch (err) { if (!(err instanceof BadName)) throw err; }
  }
  return {error: `could not parse reference: ${ref}`};
}

const OCI_REGISTRIES = new Set(['docker.io', 'registry-1.docker.io', 'index.docker.io', 'ghcr.io', 'quay.io', 'mcr.microsoft.com']);
const ociAllowed = (r) => OCI_REGISTRIES.has(r) || r.endsWith('.pkg.dev') || r.endsWith('.azurecr.io');

function ociPackage(pkg) {
  const id = str(pkg.identifier);
  if (!id) return ['package identifier is required for OCI packages', 'registry-identifier-required'];
  if (str(pkg.registryBaseUrl)) return ["OCI packages must not have 'registryBaseUrl' field - use canonical reference in 'identifier' instead (e.g., 'docker.io/owner/image:1.0.0')", 'registry-base-url-not-allowed'];
  if (str(pkg.version)) return ["OCI packages must not have 'version' field - include version in 'identifier' instead (e.g., 'docker.io/owner/image:1.0.0')", 'registry-version-not-allowed'];
  if (str(pkg.fileSha256)) return ["OCI packages must not have 'fileSha256' field", 'registry-file-sha256-not-allowed'];
  const ref = ociRegistry(id);
  if (ref.error) return [`invalid OCI reference: ${ref.error}`, 'registry-invalid-oci-reference'];
  if (!ociAllowed(ref.registry)) return [`unsupported OCI registry: ${ref.registry}`, 'registry-unsupported-oci-registry'];
  return null;
}

const GITHUB_RELEASE = /^\/([a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]+)\/releases\/download\/([^/]+)\/([^/]+)$/;
const GITLAB_RELEASE = /^\/([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)\/-\/releases\/([^/]+)\/downloads\/([^/]+)$/;
const GITLAB_PACKAGE = /^\/([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)\/-\/package_files\/([0-9]+)\/download$/;

function mcpbPackage(pkg) {
  const id = str(pkg.identifier);
  if (!str(pkg.fileSha256)) return ['must include a fileSha256 hash for integrity verification', 'registry-file-sha256-required'];
  if (!id) return ['package identifier is required for MCPB packages', 'registry-identifier-required'];
  if (str(pkg.registryBaseUrl)) return ["MCPB packages must not have 'registryBaseUrl' field - use the full download URL in 'identifier' instead", 'registry-base-url-not-allowed'];
  const u = goParseURL(id);
  if (u.error) return [`invalid MCPB package URL: ${u.error}`, 'registry-invalid-mcpb-url'];
  const host = u.host.toLowerCase();
  if (!['github.com', 'www.github.com', 'gitlab.com', 'www.gitlab.com'].includes(host)) {
    return [`MCPB packages must be hosted on allowlisted providers (GitHub or GitLab). Host '${host}' is not allowed`, 'registry-mcpb-host-not-allowed'];
  }
  if (host.endsWith('github.com') && !GITHUB_RELEASE.test(u.path)) {
    return ["GitHub MCPB packages must be release assets following the pattern '/owner/repo/releases/download/tag/filename'", 'registry-mcpb-invalid-release-url'];
  }
  if (host.endsWith('gitlab.com') && !GITLAB_RELEASE.test(u.path) && !GITLAB_PACKAGE.test(u.path)) {
    return ["GitLab MCPB packages must be release assets following patterns '/owner/repo/-/releases/tag/downloads/filename' or '/owner/repo/-/package_files/id/download'", 'registry-mcpb-invalid-release-url'];
  }
  if (u.scheme !== 'https') return [`invalid MCPB package URL, must use HTTPS: ${id}`, 'registry-mcpb-https-required'];
  if (!id.toLowerCase().includes('mcp')) return [`MCPB package URL must contain 'mcp': ${id}`, 'registry-mcpb-url-must-contain-mcp'];
  return null;
}

function packageProblem(pkg) {
  const type = str(pkg.registryType);
  if (type in URLS) return baseURLPackage(type, pkg);
  if (type === 'oci') return ociPackage(pkg);
  if (type === 'mcpb') return mcpbPackage(pkg);
  return [`unsupported registry type: ${type}`, 'registry-unsupported-type'];
}

function registryIssues(doc) {
  const out = publisherProvidedIssues(doc);
  (Array.isArray(doc.packages) ? doc.packages : []).forEach((pkg, i) => {
    const p = pkg && typeof pkg === 'object' ? pkg : {};
    const problem = packageProblem(p);
    if (problem) {
      const [message, reference] = problem;
      out.push(issue(`packages[${i}]`, `registry validation failed for package ${i} (${str(p.identifier)}): ${message}`, reference));
    }
  });
  return out;
}

module.exports = {registryIssues, reduceMeta, MAX_PUBLISHER_PROVIDED, PUBLISHER_PROVIDED};
