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

The service mirrors the official MCP Registry into its store and serves it
through the same API.

- **Schedule**: at start, then every `upstream.intervalMinutes` (default 60,
  never below 10). The first run is a full sync: about 2 400 requests and tens
  of minutes for the catalogue of November 2026. It resumes from the last
  applied page after a restart, and the service answers with what is loaded
  meanwhile (`GET /v0.1/x/io.github.mchen6/countinghouse-registry/mirror`
  says `syncing`).
- **Reconciliation**: a full pass once every `upstream.reconcile.everyDays`
  days (default 7) at the UTC hour `upstream.reconcile.atHour` (default 3).
  Records the pass does not see are served as deleted (gone upstream). If a
  pass sees fewer than half the records of the previous one, it hides nothing
  and the mirror state turns `failed` with `upstream-shrank`: check the
  official registry before the next pass.
- **Identity**: requests carry
  `User-Agent: countinghouse-registry/<version> (+https://github.com/mchen6/countinghouse-registry)`.
- **Failures**: on errors and rate limits the mirror waits (`Retry-After`, or
  backoff from 5 s, up to the interval) and resumes; `/healthz` and the
  mirror endpoint show `lastError` (`network`, `http-4xx`, `http-5xx`,
  `http-429`, `bad-page`, `upstream-shrank`). A failed mirror does not make
  `/healthz` unhealthy: the API keeps serving what it has.

## Backups (spec section 13.3)

The SQLite file and its `-wal` file are the registry's only state. For a
consistent copy use SQLite's online backup (`sqlite3 registry.db ".backup
/backups/registry.db"`), or stop the service, or run
`PRAGMA wal_checkpoint(TRUNCATE)` and copy the file while nothing writes.
Losing the file means a full re-sync of the mirror, re-publishing the local
records and re-enabling entries.
