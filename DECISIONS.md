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
- 2026-11-10 (the maintainer, correcting an earlier wording): there is no
  "import" of existing servers. Every server on the official registry is in
  this one by mirroring and usable by any MCP client at once; and usable
  through countinghouse itself at once, the operator enabling an entry and
  the gateway serving it with keys, metering and audit, validation and the
  golden recorded automatically on enable. Migration to a native module is
  optional and later.
- 2026-11-10: version 1 scope, in that light: mirroring of the official
  catalogue as the core; the compatible read API; a metadata store;
  `server.json` validation on publish; the countinghouse extension fields; a
  generator that emits `server.json` for a countinghouse module; and "enable
  through countinghouse" for **remote** entries (the gateway as an MCP
  client). Package entries (npm, PyPI, Docker) through countinghouse follow
  the out-of-process host on the countinghouse side; hosted-entry billing
  follows P2 usage records.
