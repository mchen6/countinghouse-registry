# Decisions

- 2026-11-10 (the maintainer): the registry lives in its own repository, so
  countinghouse's 7.0.0 decision ("no publish, storage or browse machinery;
  npm is the marketplace") stands unchanged for the runtime. The registry
  is metadata only: it never fetches or stores code and never moves money.
- 2026-11-10: 100% compatibility with the official MCP Registry API and
  `server.json` schema is a hard requirement; countinghouse-specific data
  goes only in the schema's extension fields.
