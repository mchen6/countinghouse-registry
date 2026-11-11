# Operating countinghouse-registry

This document grows with the implementation; each section names the part of
the design (`docs/superpowers/specs/2026-11-10-registry-design.md`) it covers.

## Install

- Node ≥ 24.15.
- The service stores everything in one SQLite file through the `sqlite3`
  package, a hard dependency of the service. Its prebuilt binding needs
  **glibc ≥ 2.38** (check with `ldd --version`; Ubuntu 22.04 has 2.35 and
  needs `npm install --build-from-source`). The CLI package
  (`countinghouse-registry-cli`) has no native dependency.

## The mirror (spec section 6)

The service mirrors one or more upstream registries into its store and
serves them through the same API. By default it mirrors the official MCP
Registry only.

- **Upstreams**: `upstreams` is a list, in precedence order, of
  `{name, url, intervalMinutes?, reconcile?}`. Any registry that serves the
  official read API can be one, your own included, also under a path
  (`https://host.example/registry`). The default is
  `[{"name": "official", "url": "https://registry.modelcontextprotocol.io"}]`.
  An empty list turns mirroring off (a registry of local records only).
  Names match `^[a-z0-9][a-z0-9-]{0,30}$`; names and URLs are unique.
- **Precedence**: when several upstreams list the same name@version, the
  first in the list that still has it is served; a copy marked deleted there
  is served as deleted. A record is hidden only when no upstream has it any
  more. Your own published records (claimed namespaces) beat every upstream.
  `isLatest` is the upstream's own while one upstream serves every version
  of a name; otherwise this registry recomputes it with the official rule.
- **Changing the list** takes effect at the next start: a new order
  rebuilds what is served; a removed upstream's copies are dropped, and
  records only it had are served as deleted; a changed `url` (other than a
  trailing slash) counts as a different registry under the same name: its
  copies are dropped, so records only it had are served as deleted until the
  new registry's full sync brings them back. Renaming an upstream is a removal plus an addition, so
  it costs a full sync under the new name.
- **Schedule**: each upstream at start, then every `intervalMinutes`
  (default 60, never below 10). The first run is a full sync: about 2 400
  requests and tens of minutes for the official catalogue of November 2026.
  It resumes from the last applied page after a restart, and the service
  answers with what is loaded meanwhile.
- **Reconciliation**: a full pass of each upstream every
  `reconcile.everyDays` days (default 7): the first run that starts at or
  after the UTC hour `reconcile.atHour` (default 3) on the day `everyDays`
  after that upstream's last pass. Its copies the pass does not see are
  dropped from consideration (gone upstream). If a pass sees fewer than half
  the records of that upstream's previous one, it applies nothing (no
  updates, no hiding), the upstream's state turns `failed` with
  `upstream-shrank`, and the pass is tried again at the next day's hour:
  check that registry meanwhile.
- **Identity**: requests carry
  `User-Agent: countinghouse-registry/<version> (+https://github.com/mchen6/countinghouse-registry)`.
- **Failures**: on errors and rate limits the mirror waits (`Retry-After`, or
  backoff from 5 s, up to the interval; each request times out after 30 s)
  and resumes; stopping the service ends any wait at once. A failed mirror
  does not make `/healthz` unhealthy: the API keeps serving what it has.
- **State**: the public `GET /v0.1/x/io.github.mchen6/countinghouse-registry/mirror`
  shows only the aggregate across upstreams (worst state, oldest success,
  largest lag, how many upstreams), never their names or URLs. `/healthz`
  adds `upstreams`, one entry per upstream by name, with `state`,
  `lastSuccessAt`, `lag`, `lastError` (`network`, `http-4xx`, `http-5xx`,
  `http-429`, `bad-page`, `upstream-shrank`, `store`) and `upstreamVersion`.

## Claimed namespaces (spec sections 7.1 and 13.3)

`claims` lists the namespace prefixes you publish into here, such as
`io.github.<you>/`. A claim is a routing rule for this registry only: it
grants nothing on the official registry, whose own ownership checks still
apply to anything you push there. In a claimed namespace, your local
records take precedence over every upstream copy, and `isLatest` is
computed here over local and mirrored versions together.

Claims are applied at each start:
- **Added claim.** `isLatest` is recomputed for the names it covers.
- **Removed claim.** If the claim still holds local records, the service
  refuses to start (exit 2) and lists those names, so that you resolve
  them explicitly.

When an upstream copy of one of your versions differs from your record,
your record is still served. The service logs `publish.conflict` once, at
warn level, with the first 12 hex digits of both hashes.

## Keys and tokens (spec section 10)

Nobody publishes, changes a status or reaches an operator or instance route
without a registry token, and tokens come only from keys you list in the
config:

- **`publisherKeys`**: `{name, algorithm, publicKey, domains, namespaces,
  operate}`. `algorithm` is `ed25519` or `ecdsa-p384`. `publicKey` is
  standard base64 of the raw public key: 32 bytes for Ed25519, the 49-byte
  compressed point for P-384. This is the same value as the `p=` of an
  `MCPv1` DNS record. `domains` are what `mcp-publisher login dns|http
  --domain` sends. `namespaces` are the claims this key may publish into.
  `operate` allows the operator endpoints.
- **`instances`**: `{instance, algorithm, publicKey}`, one per gateway
  instance id.

A key that does not parse refuses startup (exit 2) and names the field.

### With mcp-publisher

An unmodified `mcp-publisher` works against this registry:

```
mcp-publisher login dns --domain example.com --private-key <hex> --registry https://<this registry>
mcp-publisher publish
```

`login http` works the same way. The registry verifies the signature
against the keys configured for that domain. **It never looks up a DNS TXT
record or fetches a well-known file**, so the domain proves nothing beyond
"a configured key signed this". What a token may publish comes from the
key's `namespaces`, never from the domain. The `github-at`, `github-oidc`,
`oidc` and `none` logins answer 404, naming `dns` and `http`.

A signed timestamp must be within ±15 seconds of the registry's clock, and
it is accepted once.

### Tokens and revocation

Tokens are HS256 JWTs, valid for **5 minutes**. They are signed with a
secret of 64 hex characters (32 bytes), from one of two places:

- the file `secret.file`, by default `.jwt-secret` beside the store. It is
  generated on first start with mode 0600. The service refuses to start if
  the file is readable by group or others, is a symbolic link or is
  malformed; or
- the environment variable `COUNTINGHOUSE_REGISTRY_SECRET`, in the same
  form. When it is set, no file is generated.

If both the file and the variable are present, the service refuses to
start. Changing the secret ends every token issued with the old one. The
secret is never logged.

**Revocation**: remove the key from the config and restart. New
exchanges with that key stop at once. Tokens it already obtained stay valid
until they expire, so revocation takes full effect within 5 minutes of the
restart.

### Behind a reverse proxy

The exchange routes are rate-limited per source address: 10 requests a
minute, then 429 with `Retry-After`. An IPv6 source counts as its /64.
Behind a reverse proxy, set `listen.trustProxy: true`. The source is then
the address your proxy appended to `X-Forwarded-For` (exactly one hop is
trusted), so an entry the client wrote itself never counts. Use it only
with exactly one proxy in front, one that appends the client's address
(nginx `proxy_add_x_forwarded_for`). Without it, every client behind the
proxy shares the proxy's address. The forwarded address is held only in
the limiter's memory and is never logged or stored.

### Logs

Exchanges are logged as `auth.exchange` (issued) and
`auth.exchange.refused` (with a `reason`). Each line names the method, the
key name or instance id (`gateway`), and the key's fingerprint: upstream's
format, `<algorithm>:<first 8 base64 characters of the key>`. A line never
holds a token, a signature, a key or the secret.

## Operator endpoints (spec sections 6.8, 7.2 and 7.3)

These need a token from a key with `operate: true`. They live under
`/v0.1/x/io.github.mchen6/countinghouse-registry/` (and `/v0/x/…`) and send
no CORS headers.

- `GET conflicts`: every recorded conflict, where an upstream copy differs
  from your local record. Each entry has `localSha256`, `upstreamSha256`,
  `firstSeen`, `acknowledgedBy` and `acknowledgedAt`. A conflict never stops
  serving; it blocks new enables of that version until you acknowledge it.
  An upstream copy that becomes identical closes it. An acknowledgement
  covers the pair of versions it was made against: a new upstream variant
  reopens the conflict.
- `POST conflicts/{name}/versions/{version}/acknowledge`: records your key's
  fingerprint and the time. Repeating it changes nothing.
- `POST overrides/{name}/versions/{version}` with `{"keepDeleted": true}`,
  and `DELETE` of the same path. This means "I accept this entry" for a
  version that is deleted or gone upstream, and only for such a version
  (409 otherwise: you accept a version that is deleted or gone, never one in
  advance). It silences the notice on
  instances that serve it and permits new enables. It **never changes
  public responses**: the record stays hidden, its status stays upstream's,
  and its `changedAt` does not move.
- `POST mirror/sync`, optionally with `{"upstream": "<name>"}`: starts a
  mirror run now. It answers 202 when at least one asked-for upstream
  started; without a name, upstreams already mid-run are skipped. It
  answers 409 only when every upstream asked for is already running, so
  name the upstream to be sure of that one. It answers 404 for a name that
  is not configured, or when no upstreams are.
- `GET mirror/upstreams`: the named state of each upstream.

Reads with an operator token show more under our key. A mirrored record
shows `upstream` (the upstream it is served from), `alsoAt` (lower-ranked
upstreams with an identical copy) and `differsAt` (those whose copy
differs). A record with a recorded conflict shows `conflict: true`. Public
reads never show these, since your upstreams are your topology. A local
record lists every upstream whose copy agrees (`alsoAt`) or differs
(`differsAt`), with no `upstream`. Every read
answers `Vary: Authorization`, and an operator read answers
`Cache-Control: private, no-store`, so a caching proxy never serves an
operator's view to the public.

Each action writes an audit row (time, key fingerprint, action, subject)
and a log line `operator.action`. Neither ever holds a token.

## Enabling entries on your gateways (spec section 9)

List each gateway instance under `instances` with its public key. The
gateway exchanges a signed timestamp for an instance token and polls its
enabled list (docs/api.md has the contract).

- **Enable**: `PUT …/instances/{instance}/enabled/{name}/versions/{version}`,
  optionally `{"remote": <index>}`. Only `streamable-http` remotes are
  enabled. The gateway validates the server's `tools/list` and reports
  back.
- **Retry or approve**: a failed entry, or one whose tool list changed
  (`tools-changed`, and the gateway has stopped serving it), is fixed by
  PUTting the enable again. The gateway validates afresh.
- **Disable**: `DELETE` of the same path. The registry never stops an
  instance on its own. When upstream deletes a version or it goes away
  upstream, your instances get a notice and keep serving it until you
  disable it, or until you accept it with `keepDeleted`.
- **What you see**: `GET …/instances/{instance}/enabled` lists each entry
  with its current result and history. Operator reads of a record show
  `hosting.byInstance`.
- **What the public sees**: only `hosting: {hosted, instances}`, or nothing
  with `publicHosting: "none"`. Instance ids never appear.

Enables and disables are written to the audit table by key fingerprint.
**Removing an instance** from `instances` disables its entries at the next
start: they leave the public hosting count, and the instance's results are
refused (404) even while its last token is still valid. The service logs
`enable.instances.removed` and audits each entry as disabled by `config`.

## Health (spec section 13.4)

`GET /healthz` is **internal**: point your orchestrator's or proxy's health
check at it, and do not expose it publicly. It names your upstreams, which
are your topology. It answers 200 while the store answers and 503 when it
does not. Public clients have `GET /v0.1/health` (`{status: "ok"}`, as the
official registry) and the mirror endpoint above.

## Release checklist

- Run `node scripts/check-upstream-validate.js`. It posts each "valid here"
  example (`packages/cli/test/fixtures/valid-here/`) to the official
  registry's `POST /v0.1/validate` and fails if upstream finds any of them
  invalid. This is the manual half of the rule that a `server.json` valid
  here is publishable upstream (spec section 14). It is never run in CI.
- When the pinned upstream commit moves, regenerate the ported validator
  cases from a clone at the new commit:
  `node scripts/port-upstream-fixtures.js <clone>`. The script reads
  upstream's Go test tables and runs no Go code.
- Before the first release, a person runs the official mcp-publisher
  release binary against a test instance: `login dns`, `publish`, then read
  the record back. The automated check replays mcp-publisher's requests as
  its source sends them; only this run exercises the binary itself.

## Backups (spec section 13.3)

The SQLite file and its `-wal` file are the registry's only state. For a
consistent copy use SQLite's online backup (`sqlite3 registry.db ".backup
/backups/registry.db"`), or stop the service, or run
`PRAGMA wal_checkpoint(TRUNCATE)` and copy the file while nothing writes.
Losing the file means a full re-sync of the mirror, re-publishing the local
records and re-enabling entries.
