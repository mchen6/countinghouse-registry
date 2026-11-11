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

## Backups (spec section 13.3)

The SQLite file and its `-wal` file are the registry's only state. For a
consistent copy use SQLite's online backup (`sqlite3 registry.db ".backup
/backups/registry.db"`), or stop the service, or run
`PRAGMA wal_checkpoint(TRUNCATE)` and copy the file while nothing writes.
Losing the file means a full re-sync of the mirror, re-publishing the local
records and re-enabling entries.
