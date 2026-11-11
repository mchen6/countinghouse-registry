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

`hosting` is `{hosted: true, instances: N}` while N ≥ 1 gateway instances
serve the version (they validated it). An absent `hosting` means either
that no instance serves it or that the operator hides hosting
(`publicHosting: "none"`); it is never a third state. Hosting changes do not
move `changedAt`. Instance ids never appear in public responses.

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

## Enable through countinghouse: the gateway contract (spec section 9, R1)

These routes are under `/v0.1/x/io.github.mchen6/countinghouse-registry` (and
`/v0/x/…`). They send no CORS headers and take JSON bodies of at most 1 MiB.

### Operator (a token with `operate`)

- `PUT instances/{instance}/enabled/{name}/versions/{version}`, body
  `{remote?: <index into server.remotes>}`: enables the entry on that
  instance.
  - The remote must be `streamable-http`. The default is the first one; a
    version with none is 422.
  - Refused (409) for a version with an unacknowledged conflict, and for one
    deleted or gone upstream unless the `keepDeleted` override is set.
  - The state becomes `requested`. A re-PUT records who and when, moves the
    entry's sequence and asks the gateway to validate afresh: it is how to
    retry after `failed` and how to approve a `changed` tool list.
  - An instance id not in the config is 404.
- `DELETE` of the same path: the state becomes `disabled`. The entry is kept,
  so the instance sees it on its next poll and stops serving it.
- `GET instances/{instance}/enabled`: the instance's list, with each entry's
  current `result` and its `history`.

### Instance (that instance's token, from `POST …/auth/instance`)

- `GET instances/{instance}/enabled?since=<nextSince>&limit=<1..100>` →
  `{items, nextSince}`.
  - Items are the entries whose enable, result, record status or notices
    changed after `since`, in change-sequence order. Each is
    `{name, version, state, remote, status, notices, sha256?, updatedAt}`.
  - `state` is `requested`, `validated`, `changed`, `failed` or `disabled`.
  - `remote` is the chosen object from the record's current `server.json`.
    Upstream may republish a version with different remotes, so it is
    resolved on every poll: the remote at the chosen index while that one is
    still `streamable-http`, else the first `streamable-http` remote, else
    `null`. A change to the remotes moves the sequence, so the item is
    returned. Header and variable values come from the instance's own config.
  - `notices` are any of `upstream-deprecated`, `upstream-deleted`,
    `gone-upstream`, `conflict` and `tools-changed`. A local publisher's own
    status change carries no upstream notice.
  - `nextSince` is the sequence of the last item returned, or `since` when
    there are none. It is opaque: send it back as `since` (omit it on the
    first poll).
  - A full page means "poll again now". The sequence is the cursor, and no
    change is missed or seen twice, because the sequence is taken inside
    each write and SQLite commits in that order. The default poll interval
    is 5 seconds.
- `POST instances/{instance}/results`, body
  `{name, version, outcome, reason?, tools?, previousSha256?}`. The envelope
  is closed: any other field (tenant, key, caller, usage, address) is 422.
  - `validated`: requires `tools`. Accepted for an entry in state
    `requested`.
  - `changed`: requires `tools` and `previousSha256`. Accepted in
    `validated` with the validated hash as `previousSha256`; the gateway
    has **stopped serving** the entry. Also accepted in `changed` with the
    current changed hash, which records a newer list so the operator
    approves the latest. The entry leaves `hosting` and gets the
    `tools-changed` notice.
  - `failed`: requires `reason`, one of `unreachable`, `auth-rejected`,
    `protocol-error`, `invalid-tools-list`, `timeout` or `other`, and no
    `tools`. Accepted in `requested`, `validated` or `changed`. A validated
    entry that fails leaves `hosting`.
  - Each `tools` item needs `name` (a string) and `inputSchema` (an object)
    and is otherwise open.
  - The answer is 200 `{sha256}` (`{}` for `failed`). A repeat equal to the
    current result is 200 and changes nothing. A result the state rules
    refuse is still 200 with no change when an equal result was accepted
    earlier in the same enable (a late retry); otherwise it is 409. A result
    they accept is recorded even when an equal one came earlier, so a list
    that changes back is recorded as the current list.
  - A disabled entry, or one not enabled for the instance, is 409. More
    than 500 `tools` is 413.
  - Every accepted result is kept as history.

**The result hash (the contract the gateway is held to).** The registry
hashes the object `{tools}`, whose `tools` is the `tools` array of the
`tools/list` result exactly as the listed server served it. The hash is
`sha256Canonical` from `countinghouse-registry-cli/lib/canonical-json`
(countinghouse's canonical JSON serialisation), as 64 lower-case hex
digits. The gateway computes the same hash of the same input, compares it
with the returned `sha256`, and posts that value as `previousSha256` when it
reports `changed`.

**The gateway's side (R1).**
- It re-takes `tools/list` for every served entry on a schedule (hourly by
  default) and on every reconnect, compares it with the validated hash, and
  on a difference stops serving and posts `changed`.
- A `remote` with a different URL from the one it serves is handled as a
  reconnect: it re-takes `tools/list`, compares, and posts `changed` on a
  difference. A `null` remote means stop serving the entry and post
  `failed` with reason `other`.
- It retries failed connections with its own backoff and posts `failed`
  only after its retry budget. The registry never schedules retries.
- It retries result posts until they are accepted; they are idempotent.
