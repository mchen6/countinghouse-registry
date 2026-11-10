# countinghouse-registry

An MCP server registry that can **host** what it lists.

Status: design only (2026-11-10). No code yet.

## What it is

A registry that implements the official MCP Registry API and `server.json`
schema unchanged, so every MCP client and subregistry that reads the official
registry can read this one, and this one can mirror the official catalogue.
On top of the standard entry it adds what a [countinghouse](https://github.com/mchen6/countinghouse)
deployment knows about a server: its validated tool surface, declared
permissions, pricing, composition targets, and whether a hosted instance is
running, carried in the schema's extension fields and invisible to clients
that do not know them.

The difference from a plain registry: an entry is not only "where to get it"
but can be **"run it here"**, as a countinghouse module with per-key access,
metering, identity hand-off, audit and a validated tool contract.

## What it supports

- **countinghouse modules**, advertised as registry entries (npm package plus
  the `npx countinghouse --loadModule` run form, or a hosted remote).
- **Existing MCP servers in any language**, imported through countinghouse's
  out-of-process host: the operator pulls the package or image, the registry
  validates its `tools/list` and records a golden, and the gateway serves it
  as a module.
- **Gradual migration** from an imported server to a native module: wrap it
  as is; then a composite module reimplements some tools and proxies the
  rest; then the proxy is retired. The recorded tool surface is the
  regression test throughout.

## Relationship to countinghouse

countinghouse itself stays what it is: a runtime that builds no publish,
storage or browse machinery (its 7.0.0 decision; npm is its marketplace).
The registry is a separate product that *uses* countinghouse. It stores
metadata only: never code, never payments. See `docs/notes/`.

## License

Apache-2.0, like countinghouse.
