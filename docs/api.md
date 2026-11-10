# countinghouse-registry API

The registry implements the official MCP Registry's read API unchanged
(`/v0.1`, with every route also under `/v0`) and adds countinghouse data
only through the standard's extension points. The design is
`docs/superpowers/specs/2026-11-10-registry-design.md`; this page is for
clients and operators.

## Read API

- `GET /v0.1/servers`: `cursor`, `limit` (default 30, 1–100), `search`
  (case-insensitive substring of the name, at least 3 characters),
  `updated_since` (RFC 3339), `version` (`latest` or exact), `include_deleted`.
- `GET /v0.1/servers/{name}/versions`
- `GET /v0.1/servers/{name}/versions/{version}` (`latest` is special)

Path segments are URL-encoded (`io.github.user%2Fweather`; `+` in a version
as `%2B` or as is). Errors are `application/problem+json`, as the official
registry sends them.

### How this registry differs, deliberately

- **Order**: one record per server version, by name, then version, both
  compared bytewise (UTF-8 byte order). Cursors are opaque; never build one.
- **`updated_since` filters on our own change time** (`changedAt`, served
  under our `_meta` key), not on the served `updatedAt`, which stays the
  official registry's for mirrored records. A downstream sync therefore gets
  a superset: records whose `updatedAt` is older than its checkpoint can
  appear (dedupe by name and version), but a record that reached us late
  never goes missing. As with the official registry, keep a small overlap
  between sync windows: a time filter has a narrow race between a write and
  a read that start in the other order.

## Our `_meta` key

`_meta["io.github.mchen6/countinghouse-registry"]` on every record:
`origin` (`local`, `mirror` or `local+upstream`), `changedAt`, and
`mirroredAt` for records that came from the official registry. The official
key `io.modelcontextprotocol.registry/official` is on every record; its name
is historical and says nothing about where a record came from.
