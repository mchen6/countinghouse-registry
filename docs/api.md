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
`mirroredAt` for records that came from an upstream registry, and `record`
(`{sha256, recordVersion}`) when a countinghouse record is stored for that
version. The official
key `io.modelcontextprotocol.registry/official` is on every record; its name
is historical and says nothing about where a record came from. Public
responses never say which upstream registry a mirrored record came from.

## Extension endpoints

Under `/v0.1/x/io.github.mchen6/countinghouse-registry` (and `/v0/x/…`):

- `GET …/mirror` (public): how complete the mirrored catalogue is, across
  every upstream registry this one mirrors:
  `{state, lastSuccessAt, lag, upstreams}`. `state` is the worst of the
  upstreams' (`failed`, then `syncing`, then `idle`); `lastSuccessAt` is the
  oldest of their last successful runs and `lag` the largest of their ages
  in seconds, each `null` while it is unknown for any upstream (one that
  has never completed a run);
  `upstreams` is how many there are. While `state` is not `idle` the
  catalogue may be partial or stale.
- `PUT …/records/{name}/versions/{version}` (a publisher token for the
  name's claimed namespace): stores the countinghouse record of a module
  version (spec section 8). It answers 201 `{sha256}` for a new record, 200
  for identical content (key order does not matter) and 409 for different
  content, because records are immutable. A body that is not a valid record
  is 422 `{errors}`. A body over 1 MiB, or with more than 500 tools, is 413.
- `GET …/records/{name}/versions/{version}` (public): the record as stored,
  or 404.
- Operator endpoints (a token with the `operate` permission; no CORS):
  `GET …/conflicts`, `POST …/conflicts/{name}/versions/{version}/acknowledge`,
  `POST` and `DELETE …/overrides/{name}/versions/{version}`
  (`{keepDeleted: true}`), `POST …/mirror/sync` (`{upstream?}`: 202, or 409
  while running) and `GET …/mirror/upstreams`. See docs/operator.md. Any
  read with an operator token also shows `upstream`, `alsoAt`, `differsAt`
  and `conflict` under our key.
- `POST …/auth/instance`: a gateway instance's token exchange,
  `{instance, timestamp, signed_timestamp}`, verified against that
  instance's configured key. It answers like the domain exchanges below,
  with `Instance authentication failed`.

## Authentication (spec section 10)

- `POST /v0.1/auth/dns` and `POST /v0.1/auth/http` (and the `/v0` forms,
  which `mcp-publisher` uses) take upstream's body
  `{domain, timestamp, signed_timestamp}`. `timestamp` is RFC 3339 and
  within ±15 s. `signed_timestamp` is the hex signature of the timestamp,
  made with a key configured for the domain. On success the answer is 200
  `{registry_token, expires_at}`, as upstream's: an HS256 token valid for 5
  minutes, with `expires_at` in Unix seconds. A signed timestamp works only
  once.
- A refusal is upstream's 401 shape:
  `{title: "Unauthorized", status: 401, detail: "DNS authentication
  failed" | "HTTP authentication failed", errors: [{message}]}`. A JSON body
  that does not decode is 422 `validation failed`. A body that is not JSON
  is 400 `The request body is not valid JSON`, as on every write route. More than 10 exchange
  requests a minute from one source is 429 with `Retry-After`.
- `POST /v0.1/auth/github-at`, `github-oidc`, `oidc` and `none`: 404, naming
  `dns` and `http`.
- Write routes take `Authorization: Bearer <registry_token>`. A missing,
  invalid or expired token is 401 `Invalid or expired Registry JWT token`. A
  token without the permission is 403.

## Publishing (spec section 7)

Publishing is for the operator's claimed namespaces only (`claims` in the
config). The token comes from `POST /v0.1/auth/dns` or `/http`, so an
unmodified `mcp-publisher` works.

- `POST /v0.1/publish` (and `/v0/publish`): upstream's request and response.
  The checks run in this order:
  - The body must decode as upstream's structs do. A property they lack is
    422 `{detail: "validation failed", errors: [{message: "unexpected
    property", location, value}]}`, before authentication, exactly as
    upstream answers (probed 2026-11-11).
  - The name must be in a claimed namespace the token may publish into,
    otherwise 403.
  - The document must be valid, otherwise 422 `Failed to publish server,
    invalid schema: call /validate for details`, with `issues` in the
    validate shape.
  - A countinghouse pointer's `sha256` must match the record stored for
    that version, otherwise 422 naming the first 12 hex digits of both.
  - The version must be new here, otherwise 409.
  - On success: 200 with the record as served. `publishedAt`, `updatedAt`
    and `statusChangedAt` come from this registry's clock, and `origin` is
    `local`.
- `POST /v0.1/validate` (public): 200 `{valid, issues}`, as upstream's
  ValidationAll. A non-current `$schema` is only a warning there, while
  publish requires the current one. A body that does not decode is 422,
  as above.
- `PATCH /v0.1/servers/{name}/versions/{version}/status` and
  `PATCH /v0.1/servers/{name}/status`: upstream's body
  `{status, statusMessage?}` and responses. They change local records only.
  On a mirrored record they answer 409 `mirrored records follow upstream;
  use an override`.
- `PUT` and `DELETE` of a version: 501. Published versions are immutable.
- A record that exists locally takes precedence over the mirror. An
  identical upstream copy makes it `local+upstream`; a different one is a
  conflict, shown to the operator. In a claimed namespace, `isLatest` is
  computed by this registry over the local and mirrored versions together.
