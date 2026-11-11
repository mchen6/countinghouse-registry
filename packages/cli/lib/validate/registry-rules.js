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

// go-containerregistry's name.ParseReference (default, non-strict options), as far
// as the registry it names: "[registry/]repository[:tag|@sha256:digest]". The first
// component is the registry only when it holds '.' or ':' (else Docker Hub); a tag
// is 1-128 of [A-Za-z0-9_.-]; a repository 2-255 of [a-z0-9_./-].
function ociRegistry(ref) {
  const bad = {error: `could not parse reference: ${ref}`};
  let name = ref;
  const at = name.indexOf('@');
  if (at >= 0) {
    if (!/^sha256:[0-9a-f]{64}$/.test(name.slice(at + 1))) return bad;
    name = name.slice(0, at);
  }
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name.slice(colon + 1))) return bad;
    name = name.slice(0, colon);
  }
  const slash = name.indexOf('/');
  let registry = 'index.docker.io';
  let repo = name;
  if (slash >= 0) {
    const first = name.slice(0, slash);
    if (first.includes('.') || first.includes(':')) { registry = first; repo = name.slice(slash + 1); }
  }
  if (!/^[a-z0-9_./-]{2,255}$/.test(repo)) return bad;
  if (registry === 'docker.io') registry = 'index.docker.io';
  return {registry};
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
