# Brainstorm: a registry that can host what it lists

Notes from the maintainer and the reviewer session, 2026-11-10. Not a spec.

## The idea

An MCP registry, compatible with the official one, whose entries can be
hosted by countinghouse: list a server, press "host it here", and it runs
under countinghouse with per-key access, metering, identity hand-off,
audit and a validated tool contract.

## Compatibility

- Implement the official registry's read API and `server.json` schema
  unchanged; mirror the official catalogue as a subregistry.
- Countinghouse data in extension fields only: validated tool surface
  (the golden `tools/list`), declared permissions, pricing, composition
  targets, hosting status.
- Verify the current registry spec at build time; it was still being
  revised through 2025.

## What exists in countinghouse already

`countinghouse-validate` (contract validation), the golden `tools/list`,
the MCP conformance tests against the official SDK, the stateless
Streamable HTTP gateway, the module skill, R2-1's opaque identity (in
progress), the metering provider, and the approved logger/errors design.

## What is new

- The registry API server (metadata store, read API, mirroring, publishing).
- The out-of-process host for servers in other languages (the "mcp-proxy"
  module in front of a container or child process; see countinghouse's
  `docs/superpowers/notes/2026-11-10-multi-language-modules-brainstorm.md`).
- Import: pull by the operator, validate `tools/list`, record a golden,
  register as a module.
- Migration tooling: generate `api.json`/`schema.json` from a server's
  `tools/list` (MCP tool schemas map onto them nearly one-to-one), and use
  the recorded golden as the migration's regression test.
- Hosting status and a bill per hosted entry, which needs countinghouse's
  P2 usage records.

## Migration path (composition makes it natural)

1. Wrap: the server runs as is behind the proxy; it gains keys, metering,
   audit.
2. Hybrid: a composite module reimplements some tools natively and calls
   the rest through the proxy; callers see one surface.
3. Native: the proxy is retired.

## Prerequisites and order

After countinghouse's R2-1 (identity without keys), the error/logger
series, and the out-of-process host; P2 usage records before hosted
billing. First spec step: the out-of-process host.

## Open decisions

1. Name of the product and the repository.
2. Public or private repository at first.
3. Whether the registry's web UI is in scope for version 1, or API only.
4. Whether the registry API itself is served by a countinghouse module
   (dogfooding) or by a small separate service.
5. Who can publish entries (the operator only, or module authors directly)
   and what review precedes a hosted entry.
