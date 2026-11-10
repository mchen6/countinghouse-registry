# countinghouse-registry

An MCP server registry that can **host** what it lists.

Status: design only (2026-11-10). No code yet.

## What it is

A registry that implements the official MCP Registry API and `server.json`
schema unchanged, so every MCP client and subregistry that reads the official
registry can read this one, and this one can mirror the official catalogue.
On top of the standard entry it adds what a [countinghouse](https://github.com/mchen6/countinghouse)
deployment knows about a server: its validated tool surface, declared
permissions, composition targets, and whether a hosted instance is
running, carried in the schema's extension fields and invisible to clients
that do not know them. (Prices are per countinghouse deployment, not per
module, and are not published.)

The difference from a plain registry: an entry is not only "where to get it"
but can be **"run it here"**, as a countinghouse module with per-key access,
metering, identity hand-off, audit and a validated tool contract.

## What it supports

- **Every server on the official MCP Registry, with no import step.** The
  catalogue is mirrored, entry for entry, so any MCP client that can use the
  official registry can use this one today. The registry *is* the catalogue;
  there is no "import" of a server into it.
- **Those servers usable through countinghouse itself, immediately.** The
  operator enables an entry and countinghouse serves its tools through its
  gateway, with per-key access, metering, identity hand-off and audit, with
  no conversion and no manual ceremony: the tool surface is validated and its
  golden recorded automatically when the entry is enabled. Remote entries (a
  URL) need only the gateway acting as an MCP client; package entries (npm,
  PyPI, Docker) need countinghouse to run them out of process, which follows
  the countinghouse work it depends on.
- **countinghouse modules**, listed alongside them (npm package plus the
  `npx countinghouse --loadModule` run form, or a hosted remote), and
  countinghouse deployments themselves as entries.
- **Migration to a native module, optional and later**: a composite module
  reimplements some tools and serves the rest through the enabled entry;
  then the entry is retired. The recorded tool surface is the regression
  test throughout.

## Relationship to countinghouse

countinghouse itself stays what it is: a runtime that builds no publish,
storage or browse machinery (its 7.0.0 decision; npm is its marketplace).
The registry is a separate product that *uses* countinghouse. It stores
metadata only: never code, never payments. See `docs/notes/`.

## License

Apache-2.0, like countinghouse.
