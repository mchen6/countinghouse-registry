# Decisions

- 2026-11-10 (the maintainer): the registry lives in its own repository, so
  countinghouse's 7.0.0 decision ("no publish, storage or browse machinery;
  npm is the marketplace") stands unchanged for the runtime. The registry
  is metadata only: it never fetches or stores code and never moves money.
- 2026-11-10: 100% compatibility with the official MCP Registry API and
  `server.json` schema is a hard requirement; countinghouse-specific data
  goes only in the schema's extension fields.
- 2026-11-10 (the maintainer, on the reviewer's recommendation): version 1 is
  API only (a read-only web page later); the registry API is a small separate
  Node service, not a countinghouse module (it may move into one once
  countinghouse's out-of-process host exists); publishing is operator-only in
  version 1 (author self-publishing with review later).
- 2026-11-10: version 1 scope: the compatible read API, a metadata store,
  mirroring of the official catalogue, `server.json` validation on publish,
  the countinghouse extension fields, and a generator that emits `server.json`
  for a countinghouse module. Not in version 1: hosting or importing foreign
  servers and migration tooling (they wait on countinghouse's R2-1, the
  out-of-process host and P2 usage records).
