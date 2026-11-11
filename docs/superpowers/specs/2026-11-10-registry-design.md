# countinghouse-registry, version 1: design

Status: approved 2026-11-10. Amended 2026-11-10 for several upstreams
(section 6.8, agreed with the reviewer on the maintainer's direction that an
operator's own registry is a first-class mirror source).
Counterpart in the design conversation: the reviewer session, which holds the
maintainer's decisions. Inputs: `DECISIONS.md`, `README.md`,
`docs/notes/2026-11-10-registry-brainstorm.md` and the research note
`docs/notes/2026-11-10-mcp-registry-spec-research.md` (cited below as
"research §n"). Every rule here was agreed in that conversation; the calls
the implementer made alone are marked **(implementer's call)** and listed
again in section 17.

## 1. Intent

An MCP server registry that any MCP client can read exactly as it reads the
official registry, and whose entries can be **run here**: served through a
countinghouse gateway with per-key access, metering, identity hand-off,
audit and a validated tool contract.

Version 1 makes that true for two kinds of entry:

- **Every server on the official registry**, by mirroring. There is no
  import step: a mirrored entry is usable by any client at once, and the
  operator can **enable** a remote entry so their countinghouse gateway
  serves it, with its tool list validated and recorded automatically.
- **countinghouse modules**, published here by the operator from a module's
  npm package, carrying a countinghouse record (the validated tool surface,
  the modules it calls, its declared permissions) that clients unaware of
  countinghouse never see.

Why now: the official registry's read API has been frozen (additive only)
since 2025-10-24 and its catalogue holds about 61 000 servers (research,
snapshot), so a compatible registry is buildable against a stable target,
and countinghouse already has the validator and tool-list golden the
"run it here" half needs.

## 2. Goals, non-goals, anti-goals

Goals (version 1):

1. The compatible read API (section 4), unchanged for clients.
2. The metadata store (section 13.3).
3. Mirroring of the official catalogue as the core, and of any other
   API-compatible registry the operator lists, such as their own (section 6).
4. Operator-only local publishing with `server.json` validation (section 7).
5. The countinghouse extension fields and records (section 8).
6. "Enable through countinghouse" for **remote** entries: this repo's half
   and the wire contract for countinghouse's half (section 9).
7. A generator that emits `server.json` and the countinghouse record for a
   countinghouse module, and a publish command (section 11).

Non-goals (version 1): a web UI (a read-only page later); author
self-publishing (later, with review); enabling **package** entries (npm,
PyPI, OCI) through countinghouse (waits for countinghouse's out-of-process
host); hosted-entry billing (waits for countinghouse's P2 usage records);
migration tooling; pricing in any record.

Anti-goals (a failure even if everything else works):

- Any MCP client or subregistry that reads the official registry cannot read
  this one, or reads something different from what upstream would serve for
  a mirrored record.
- The registry stores or fetches code, holds third-party credentials, moves
  money, or speaks MCP itself.
- The registry publishes an operator's deployment topology, effective
  permissions or prices, or logs a secret.
- A `server.json` accepted here could not be published to the official
  registry as is (ownership checks aside).

## 3. Constraints

From `DECISIONS.md` and the brief:

- Separate repository and product; countinghouse's 7.0.0 decision stands.
  Metadata only: never code, never money.
- 100% compatibility with the official API and `server.json` schema;
  countinghouse data only through the standard's extension points:
  `server.json` `_meta` (`io.modelcontextprotocol.registry/publisher-provided`
  for anything meant to survive a push upstream, ≤4096 bytes), response-level
  `_meta` under our own key, and extension endpoints under `/v0.1/x/<ns>/`.
- A small separate Node service, not a countinghouse module. API only.
- Operator-only publishing.
- Apache-2.0. Node ≥ 24 (CI on 24.15.0, 24 and 26). Express 4, ajv 8,
  sqlite3 (`^6`); no framework countinghouse does not already use; no Redis.
- A countinghouse module's run form is the **generated launcher**
  (section 11.1; the maintainer's decision, recorded in `DECISIONS.md` with
  this spec).
- The mirror's User-Agent is
  `countinghouse-registry/<version> (+https://github.com/mchen6/countinghouse-registry)`
  (decided by the reviewer on the maintainer's delegation; recorded in
  `DECISIONS.md` with this spec).

## 4. The read API

### 4.1 What is reproduced exactly

Research §8 is the reference; in short:

| Area | Rule |
|---|---|
| Paths | `GET /v0.1/servers`, `GET /v0.1/servers/{name}/versions`, `GET /v0.1/servers/{name}/versions/{version}` (`latest` special). Path segments URL-decoded (`%2F`, `%2B`). |
| `/v0` aliases | Every `/v0.1/...` route in this spec, including `/v0.1/x/...`, is also served under `/v0/...` with identical behaviour, so `mcp-publisher` (which only speaks `/v0`) works. |
| List parameters | `cursor`, `limit` (default 30, 1–100, otherwise 422), `search`, `updated_since` (RFC 3339, otherwise 400; forces `include_deleted=true`; explicit `include_deleted=false` with it is 400), `version` (`latest` or exact), `include_deleted` (default false). |
| Search | Case-insensitive substring of `name`; a nonempty value needs ≥3 Unicode characters after trimming, otherwise 422 with upstream's detail text. Backed by an SQLite FTS5 `trigram` table on names. |
| Order | One record per server version, ordered by `name`, then `version`, ascending, **bytewise** (UTF-8 byte order: SQLite `BINARY`); documented as such. `/versions` is ordered by `publishedAt` descending. |
| `updated_since` here | Filters on the record's **local change time** `changedAt` (served under our key, 5.2), not on the served `updatedAt`, which stays upstream's for mirrored records. `changedAt` moves on every change applied here (mirror apply, origin change, status overlay, override, local publish or status change), not on hosting-count changes. A deliberate superset: a downstream registry may receive records whose `updatedAt` is older than its checkpoint (it dedupes by name + version) but never misses one that reached us late, e.g. during our first sync. The API docs say so. Being a time filter, it keeps upstream's narrow race (a write whose `changedAt` is set before a reader's snapshot but which commits after it); the API docs repeat upstream's advice to downstream syncs to keep a small overlap. The exact, sequence-based watermark is used where we define the contract (9.4). |
| Cursor | Opaque; its format is the builder's. End of list: `nextCursor` absent. `metadata.count` = records in the page; `metadata` carries nothing else. |
| Record | `{server: <server.json as stored>, _meta: {"io.modelcontextprotocol.registry/official": {...}, "io.github.mchen6/countinghouse-registry": {...}}}` (section 5). |
| Status | `deleted` records are hidden unless `include_deleted`; a deleted version is never `isLatest` while a non-deleted version exists. |
| Errors | `application/problem+json` `{title, status, detail}`, as production sends it (research §2), never the `{error}` shape in `openapi.yaml`. 404 detail `"Server not found"`. Parameter validation errors as upstream's (checked live 2026-11-10, `?limit=101`): 422, `detail: "validation failed"`, `errors: [{message: "expected number <= 100", location: "query.limit", value: 101}]`. |
| CORS | Read routes send `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: Content-Type, Content-Length`, as upstream does (checked 2026-11-10). Write, operator and instance routes send no CORS headers. |

### 4.2 Optional generic endpoints

- `POST /v0.1/publish`: implemented (section 7).
- `PATCH /v0.1/servers/{name}/versions/{version}/status` and
  `PATCH /v0.1/servers/{name}/status`: implemented for **local** records only;
  on a mirrored record, 409 "mirrored records follow upstream; use an
  override" **(implementer's call)**.
- `PUT` and `DELETE` of a version: 501 with problem detail. Records are
  immutable once published **(implementer's call)**, as upstream treats them
  for publishers.
- `POST /v0.1/validate`: implemented, upstream's shape: 200 with
  `{valid, issues: [{type, path, message, severity, reference}]}` for any
  body that parses as a `ServerDetail`; a body that does not is 422
  problem+json, as upstream does.
- Not served: `/v0.1/auth/github-at`, `/github-oidc`, `/oidc`, `/none`
  (404 problem+json naming the supported methods). Served: `/v0.1/auth/dns`
  and `/v0.1/auth/http` (section 10).
- Service routes: `GET /v0.1/ping`, `GET /v0.1/version`
  (`{version, git_commit, build_time}` like upstream), `GET /v0.1/health`
  (upstream's route and shape, `{status: "ok"}`; upstream also sends a
  `github_client_id`, which we have no use for) and `GET /healthz` (our
  detailed health, section 13.4).

## 5. Records and `_meta`

### 5.1 The official key on every record

Every record served carries
`_meta["io.modelcontextprotocol.registry/official"]` with exactly upstream's
fields: `status`, `statusMessage` (if any), `statusChangedAt`, `publishedAt`,
`updatedAt`, `isLatest`. It is the only carrier the API defines for status
and "latest", and clients filter on it (`version=latest`).

- The key's name is historical: its presence asserts **nothing** about
  origin. Provenance is only `origin` under our key (5.2).
- Mirrored records keep upstream's values, with the overlays of 7.3.
- Local records get our values: `publishedAt` and `updatedAt` from the
  registry's clock (UTC, RFC 3339 with fractional seconds), `updatedAt` and
  `statusChangedAt` moved by every status change; `isLatest` by 7.4.
- No field is ever added to that object (`additionalProperties: false`
  upstream).

### 5.2 Our key

`_meta["io.github.mchen6/countinghouse-registry"]`, on every record:

```json
{
  "origin": "local | mirror | local+upstream",
  "changedAt": "2026-11-10T21:04:05.123Z",
  "mirroredAt": "2026-11-10T21:04:05.123Z",
  "record": { "sha256": "<64 hex>", "recordVersion": 1 },
  "hosting": { "hosted": true, "instances": 2 },
  "conflict": true
}
```

- `origin` and `changedAt` (4.1): always. `mirroredAt`: records that came
  from (or were confirmed by) upstream.
- `record`: present when a countinghouse module record exists for this
  name@version (section 8).
- `hosting`: the public aggregate only: whether any instance serves this
  name@version and how many (instances in state `validated`). An operator
  switch `publicHosting: "aggregate" | "none"` (default `aggregate`) removes
  it. Per-instance detail is never in public responses (9.6).
- `conflict`: only on operator-authenticated reads (7.2).

Mirror state is per upstream and is **not** repeated per record: it is
served, as a public aggregate, at
`GET /v0.1/x/io.github.mchen6/countinghouse-registry/mirror` and, per
upstream, in `/healthz` (6.5).

## 6. Mirroring

### 6.1 Source and schedule

- Config lists the upstreams, in precedence order (6.8). By default there is
  one, named `official`: the official registry at
  `https://registry.modelcontextprotocol.io`. Each is read through
  `GET /v0.1/servers`. Sections 6.2 to 6.7 describe one upstream; every
  upstream has its own run, cursor, checkpoint, state, pass count and
  shrink guard.
- Interval: 1 hour by default, configurable per upstream, never below 10
  minutes (config refuses lower). An operator-only "sync now" endpoint
  starts a run at once (refused with 409 while one runs).
- Requests: one at a time per upstream, `limit=100`, `include_deleted=true` always,
  `Accept-Encoding: gzip`, the decided User-Agent.

### 6.2 First sync

The first sync is ~2 400 pages (research, snapshot: 239 329 records on
2026-11-10). It:

- streams page by page into the store (each page applied in one
  transaction), never holding the catalogue in memory;
- records the last applied cursor after each page, so a restart resumes
  from there;
- takes the `updated_since` checkpoint at the **start** of the first sync
  and commits it only after the last page is applied;
- serves whatever is loaded while it runs; the mirror state says `syncing`.

### 6.3 Incremental syncs

`updated_since = checkpoint − 5 minutes` (overlap), the same timestamp for
every page of the run, records deduplicated by name + version (an existing
record is replaced by the upstream copy when upstream's `updatedAt` is
newer), the new checkpoint = the time the run started, committed only after
its last page. Deleted versions arrive with `status: deleted` and are
applied.

### 6.4 Failures and rate limits

On a network error, 5xx or 429: honour `Retry-After` when present, otherwise
exponential backoff with full jitter starting at 5 s and capped at the
interval; never retry a page in a tight loop; resume from the stored cursor.
A run that fails leaves the checkpoint unchanged. Logs carry the upstream
status code and the page number, nothing from the response body.

### 6.5 Mirror state

Per upstream: `{name, state: "syncing" | "idle" | "failed", lastSuccessAt,
lag, lastError, upstreamVersion}`, one entry per configured upstream in
precedence order: `lag` = seconds since the start of the last successful
run; `lastError` = a short code (`network`, `http-5xx`, `http-429`,
`bad-page`, `upstream-shrank`, `store`); `upstreamVersion` from upstream's
`/v0.1/version` when it answers (read once per run).

An upstream's name is the operator's topology and appears on no public
response, its URL on no response at all (the reviewer's ruling). The public
mirror extension endpoint serves the aggregate
`{state, lastSuccessAt, lag, upstreams: <count>}`: `state` the worst across
upstreams (`failed` > `syncing` > `idle`), `lastSuccessAt` the oldest, `lag`
the largest (both `null` while any upstream has never succeeded), so a
reader knows the catalogue may be partial without learning what it is
assembled from. The per-upstream list lives in `/healthz` (internal, 13.4)
and on operator-authenticated reads.

### 6.6 Reconciliation

Incremental syncs never see a record that disappears upstream without being
marked deleted (upstream is a preview; "data resets may occur"). A full
reconciliation pass runs **weekly** by default (configurable per upstream,
never more often than daily), at a configurable hour, reusing the first-sync pager
(~2 400 requests at the same pace and User-Agent):

- every copy from that upstream not seen in the pass becomes `gone-upstream`
  (a record is hidden only when no upstream still has it, 6.8): hidden
  like a deleted one, with the same operator notice and override rules on
  enabled instances (7.3);
- if the pass sees fewer than half the records the previous pass of the
  same upstream saw, it is treated as an upstream reset: nothing is applied, the mirror state becomes
  `failed` with code `upstream-shrank`, and the operator decides (the next
  scheduled or "sync now" pass tries again).

### 6.7 Storage rule

Mirrored records are stored **as served**: the `server` object byte-for-byte
as parsed JSON, upstream's official `_meta`, never re-validated (about 12 500
records upstream use older schema versions). `isLatest` for unclaimed
namespaces is upstream's whenever one upstream serves every version of the
name; otherwise 6.8 applies.

### 6.8 Several upstreams

Config: `upstreams: [{name, url, intervalMinutes?, reconcile?}]`, in
precedence order. `name` is an opaque label chosen by the operator
(`^[a-z0-9][a-z0-9-]{0,30}$`), unique, and so is `url`; there is no alias for
a single `upstream` object. An empty list is allowed: no mirroring, a
registry of local records only **(implementer's call)**.

- **Copies.** Every upstream's copy of a name@version is stored as served
  (6.7), whatever its precedence, with its own `updatedAt` rule (6.3) and
  its own `gone-upstream` mark (6.6).
- **The served record** is a projection of those copies, rebuilt for every
  name@version a source change touches, inside the same write transaction:
  the copy of the first upstream in the list that still has it (not
  `gone-upstream`) is served. A copy with `status: deleted` is still a copy:
  a deletion at a higher-precedence upstream is served as deleted, not
  bypassed by a lower one **(implementer's call)**. The record is hidden
  (`gone-upstream`) only when no upstream has it.
- **Claimed namespaces beat every upstream** (7.2): a local record is never
  replaced by any copy; its comparison and `local+upstream` origin follow 7.2
  against the highest-precedence copy.
- **`isLatest`**: when every visible mirrored version of a name is served
  from one upstream, that upstream's values are served as they are;
  otherwise the registry recomputes it over the name's mirrored versions with
  the deployed rule of 7.4 (skipping deleted and hidden ones unless all
  are). Names with a local record follow 7.4.
- **Attribution is operator-only.** Public reads show `origin: mirror` and
  nothing about which upstream. Operator-authenticated reads (once the
  operator routes exist) add under our key `upstream` (the serving
  upstream's name) and `alsoAt` (lower-precedence upstreams whose copy is
  identical: `server` objects equal as canonical JSON with `_meta` reduced
  to `publisher-provided`, the 7.2 rule); a lower-precedence copy that
  differs is an operator-only conflict, the same shape as 7.2's.
- **Config changes, applied at startup.** A changed order rebuilds every
  served mirrored record. An upstream removed from the list loses its copies
  and state; records only it had become `gone-upstream` (still served as
  deleted where deleted records are asked for, so downstream syncs learn
  it), never removed. An upstream whose `url` changed (a trailing slash
  aside) is a different registry under the same label: its copies and state
  are dropped and it starts again with a first sync **(implementer's call)**; renaming one is a removal plus an
  addition, so a full sync under the new name (the operator docs say so).

## 7. Local publishing

### 7.1 Claimed namespaces

Config lists the namespaces the operator publishes into locally ("claimed
namespaces"), each a prefix like `io.github.<owner>/` or `com.example/`,
with the publisher keys that may write there (section 10). Local publishing
is accepted only for names in a claimed namespace; elsewhere 403.

A claim is a routing rule for this registry only. It grants nothing on the
official registry, whose own ownership checks still apply to anything
pushed there; the operator docs say so.

### 7.2 Precedence and conflicts

- Unclaimed namespaces: the mirror is the only source.
- Claimed namespaces: local records are authoritative. When the mirror
  brings a name@version that exists locally, it compares `server` objects
  with `_meta` reduced to `publisher-provided` on both sides (canonical JSON):
  - identical: the local record's `origin` becomes `local+upstream` and
    `mirroredAt` is set; upstream status changes apply as overlays (7.3);
  - different: the local record stays as served; a **conflict** is recorded
    (name, version, both hashes, first seen), shown on
    `GET /v0.1/x/<ns>/conflicts` (operator) and as `conflict: true` under our
    key on operator reads, and logged once at warn level.
- A conflict never stops serving: an entry already enabled keeps being
  served from the local record. It blocks **new enables** of that
  name@version (409 with the reason) until the operator either acknowledges
  it (`POST /v0.1/x/<ns>/conflicts/{name}/versions/{version}/acknowledge`,
  recorded with the key fingerprint and time) or publishes a new version.
- Upstream versions in a claimed namespace that do not exist locally are
  mirrored as usual.

### 7.3 Upstream status changes (all namespaces, including enabled entries)

- **Deprecated upstream**: applied (status, message, `statusChangedAt`) in
  the official `_meta`; the entry stays visible; enabled instances keep
  serving and see a notice in their enabled list.
- **Deleted upstream** (usually a moderation removal), or `gone-upstream`
  (6.6): the record is hidden here as upstream hides it. On enabled
  instances it raises an operator notice; **serving stops only when the
  operator confirms** by disabling the entry (9.3); the registry never stops
  an instance on its own. New enables of such a version are refused (409).
- **The `keepDeleted` override** (`POST /v0.1/x/<ns>/overrides/{name}/versions/{version}`,
  recorded with key fingerprint and time; `DELETE` removes it) means "the
  operator accepts this entry". It **never changes public responses** (the
  record stays hidden, status as upstream); it silences the notice on
  enabled instances and permits new enables of that version.

### 7.4 `isLatest` for claimed namespaces

Computed by the registry over the union of local and mirrored versions of
the name, skipping deleted ones (unless all are deleted), with the deployed
upstream rule (research §3, verified live): both strict semver
(`MAJOR.MINOR.PATCH[-pre][+build]`, exactly three parts) → semver order;
neither → later `publishedAt` wins; one semver → the semver one wins.
Recomputed on every publish, status change and mirror apply touching the
name, in the same transaction.

### 7.5 Validation on publish

A `POST /v0.1/publish` (operator JWT with publish permission for the name's
claimed namespace) runs, in order, collecting all issues:

0. **Decode**: no property upstream's Go structs lack (`ServerJSON`,
   `ServerMeta` and the `pkg/model` types at `7e8fa024`; `publisher-provided`
   is free-form). Upstream decodes the body through huma v2, which refuses an
   unknown property with 422 `unexpected property` before any validator runs:
   probed against the official `POST /v0.1/validate` on 2026-11-11 with an
   unknown top-level field and with a `_meta` key beside `publisher-provided`;
   both were refused. So other `_meta` keys are refused, as upstream, 422 in
   huma's shape (`{message: "unexpected property", location: "body.<path>",
   value}` under `errors`), never dropped. The same holds for our
   `POST /v0.1/validate`.
1. **Schema**: `$schema` must be exactly
   `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`;
   anything else is 422 naming the current URL. Validation against the
   vendored 2025-12-11 file (draft-07) with an ajv draft-07 instance (the
   config schema uses a separate ajv 2020-12 instance). A later schema
   version (e.g. the 2020-12 one, upstream issue #842) is added by vendoring
   its file and a config line, never fetched at run time.
2. **Semantic rules**: every rule in upstream's
   `internal/validators/validators.go` at commit `7e8fa024`, ported with its
   upstream rule id as `reference` (e.g. `version-looks-like-range`), so
   details read as upstream's.
3. **Registry rules**: upstream's base-URL allow-lists, unchanged (the
   checks each registry's validator makes before it fetches anything);
   `publisher-provided` ≤4096 bytes of compact JSON (counted as Go's
   `json.Marshal` counts: UTF-8, `<` `>` `&` escaped), otherwise 422 with
   the size.
4. **Our rule**: if `publisher-provided` carries our pointer (8.3), its
   `sha256` must equal the hash of a stored record for that name@version
   (the record is PUT first, 8.4); otherwise 422 naming the first 12 hex of
   both hashes, never the record.
5. **Uniqueness**: name@version already published locally → 409.

**No package-ownership check** in version 1 (upstream fetches the package's
metadata to compare `mcpName`): publishing is operator-only, the operator
is trusted for the namespaces they claimed, and the check would make the
registry call npm, PyPI and OCI registries. This is a named difference from
upstream; author self-publishing must add it back. The generator checks
`mcpName` locally.

Invariant: **a `server.json` valid here is publishable upstream as is,
except for package ownership.** It is held by two tests (section 14).

The response is upstream's: 200 with the `ServerResponse` as stored.

## 8. countinghouse records

### 8.1 Content

One JSON document per countinghouse module name@version:

```json
{
  "recordVersion": 1,
  "countinghouse": "^8",
  "tools": [ ... ],
  "calls": [ "log-read/readService.list", "..." ],
  "permissions": { "...": "..." }
}
```

- `countinghouse`: the module's `peerDependencies.countinghouse` range.
- `tools`: exactly what the countinghouse gateway serves on `tools/list` for
  that module alone (names as served, `outputSchema` where served), from
  countinghouse's `toolsListForModule(dir)` (11.2).
- `calls`: the module's `package.json` `countinghouse.calls` (composition
  targets), `[]` if absent.
- `permissions`: `countinghouse.permissions` **as declared**, before any
  operator policy; `{}` if absent. Documented as "declared, before operator
  policy"; effective permissions are never published.
- No pricing: countinghouse prices per deployment (`--mcpToolCallCost`), not
  per module. A future manifest price would enter as `recordVersion` 2.

### 8.2 Hash

`sha256` over countinghouse's canonical JSON of the whole record: a copy of
countinghouse's `lib/mcp/output-schema-hash.js` (`canonicalJSON` +
sha256), with a comment naming its origin and commit, and a test that the
copy and countinghouse's own fixture
`test/mcp-contract/tools-list-for-module/echo-device-module.json` (added by
N1) hash identically. A change on one side changes both.

### 8.3 The pointer in `server.json`

`_meta["io.modelcontextprotocol.registry/publisher-provided"]["io.github.mchen6.countinghouse"]`:

```json
{ "record": "https://<registry>/v0.1/x/io.github.mchen6/countinghouse-registry/records/<name%2F>/versions/<version>",
  "sha256": "<64 hex>",
  "recordVersion": 1 }
```

The URL names the registry the module's author generated against; readers
treat it as a hint and the `sha256` as the authority (any registry serving a
record with that hash is equally good; the record also ships in the npm
package, 11.1). Well under 4096 bytes.

### 8.4 Endpoints

Under `/v0.1/x/io.github.mchen6/countinghouse-registry/`:

- `PUT records/{name}/versions/{version}` (operator JWT with publish
  permission for the namespace): stores the record; 201 new, 200 identical
  content, 409 different content (immutable per name@version), 422 if it is
  not a valid record (its own JSON Schema, 2020-12: closed envelope; tool
  items as in 9.4; `permissions` any object, since countinghouse-validate
  has already checked it). Body caps as 9.4: 1 MiB, 500 tools, else 413.
  Response: `{sha256}`.
- `GET records/{name}/versions/{version}` (public): the record as stored.

Records exist only for local names (claimed namespaces). Tool lists taken
from enabled mirrored entries are instance results (9.4), not records.

### 8.5 Names (permanent)

Fixed by this spec and tied to the project's GitHub account, already a
public commitment through countinghouse's own server name
`io.github.mchen6/countinghouse`. If the project gets its own domain, new
names are only ever added.

| Use | Name |
|---|---|
| Response-level `_meta` key | `io.github.mchen6/countinghouse-registry` |
| Pointer subkey in `publisher-provided` | `io.github.mchen6.countinghouse` |
| Extension path | `/v0.1/x/io.github.mchen6/countinghouse-registry/...` (and `/v0/x/...`) |

## 9. Enable through countinghouse (remote entries)

### 9.1 Boundary

- The **registry** holds state and records results. It never speaks MCP,
  never connects to a listed server, never holds third-party credentials,
  and never calls into countinghouse.
- **countinghouse** (item R1, queued by the reviewer against this contract)
  does all MCP work: its gateway polls the registry for its enabled set,
  connects to each entry's remote with credentials from the operator's own
  countinghouse secret config, takes `tools/list`, validates it, serves it,
  and posts the result back.
- This spec's deliverable for enable is the registry side and the wire
  contract below. The gateway side is R1.

### 9.2 Instances

A gateway instance is identified by an **instance id**: an opaque value the
operator chooses (`^[a-z0-9][a-z0-9-]{0,62}$`), never a hostname or URL.
Config lists each instance id with its public key (section 10). An
instance's token may only read its own enabled set and post its own results.

### 9.3 Operator endpoints (operator JWT with the `operate` permission)

Under `/v0.1/x/io.github.mchen6/countinghouse-registry/`:

- `PUT instances/{instance}/enabled/{name}/versions/{version}`, body
  `{remote?: <index into server.remotes>}`: enable. Allowed for a visible
  record, or a deleted/gone-upstream one with the `keepDeleted` override
  (7.3), with at least one `streamable-http` remote (`sse` remotes are not
  enabled in version 1: deprecated in MCP); default remote = the first
  `streamable-http` one. 409 when the name@version has an unacknowledged
  conflict or is deleted upstream without the override; 422 when there is
  no eligible remote. State becomes `requested`; a re-PUT of an existing
  enable (recorded with key fingerprint and time) moves its `updatedAt` and
  sends the gateway to validate afresh: the way to retry after `failed` and
  to approve a `changed` tool list.
- `DELETE` of the same path: disable. State becomes `disabled` (kept, with
  time, so the instance sees it on its next poll and stops serving).
- `GET instances/{instance}/enabled`: same listing as the instance sees, plus
  the instance's results.

### 9.4 Instance endpoints (instance JWT for that instance)

- `GET instances/{instance}/enabled?since=<watermark>&limit=<1..100>`:
  entries whose enable state, result, record status or notices changed after
  the watermark, in sequence order; the sequence is also the pagination (a
  full page means "poll again now"; no separate cursor). The watermark is a
  **change sequence**, not a time: every change to an enable, a result, a
  record's status or a notice takes the next value of one monotonic counter
  inside its write transaction. SQLite has a single writer, so sequence order
  is commit order, and a read snapshot always sees a prefix of the sequence.
  Every response carries `nextSince`, the highest sequence in the snapshot;
  the gateway sends it back as `since` on its next poll (omitted on the
  first). Exact: no overlap, no clocks, no race between a write that started
  before a read and committed after it. The value is opaque to the gateway
  (a decimal string). Registry-issued watermark: **(implementer's call)**;
  sequence instead of time: the reviewer's correction.
  Each item: `{name, version, state: "requested"|"validated"|"changed"|"failed"|"disabled",
  remote: <the chosen remote object from server.json>, status: <official
  status>, notices: ["upstream-deprecated"|"upstream-deleted"|"gone-upstream"|"conflict"|"tools-changed"],
  sha256: <current result's hash, if any>, updatedAt}`. The remote object is
  served as listed (URL template, variables, header metadata); values come
  from the instance's own config.
- `POST instances/{instance}/results`, body
  `{name, version, outcome: "validated"|"changed"|"failed", reason?, tools?, previousSha256?}`:
  - `validated`: requires `tools` (the `tools` array of the `tools/list`
    result as countinghouse serves it). Accepted for an entry in state
    `requested`.
  - `changed`: the gateway found a tool list different from the one it
    validated before, **stopped serving** the entry (countinghouse's rule: a
    changed tool list is a changed contract), and posts the new `tools` with
    `previousSha256`. Accepted in state `validated` (idempotent in
    `changed`). State becomes `changed`; the entry leaves
    `hosting.instances`; the operator gets a `tools-changed` notice; a
    re-enable (9.3) sends the gateway to validate afresh. What produces it on
    the gateway's side (R1): the gateway re-takes `tools/list` for every
    served entry on a schedule (default hourly) and on every reconnect,
    compares it with the validated one by the shared hash, and posts
    `changed` on a difference.
  - `failed`: requires `reason` from `unreachable | auth-rejected |
    protocol-error | invalid-tools-list | timeout | other`, and no `tools`.
    Accepted in any enabled state; a validated entry that fails leaves
    `hosting.instances`.
  - The registry computes the hash of `{tools}` with the shared canonical
    serialisation and returns `{sha256}`; the gateway compares it with its
    own.
  - **History**: every accepted result is kept (instance, name, version,
    outcome, sha256 or reason, time); the latest is the current state.
    Operator reads show the current result and the history.
  - Idempotent: a repeat equal to the current result (same outcome and
    sha256 or reason) returns 200 and changes nothing.
  - The body carries nothing about tenants, keys, callers, usage or the
    instance's address. The envelope's JSON Schema is closed
    (`additionalProperties: false`). Each `tools` item requires `name`
    (string) and `inputSchema` (object) and is otherwise open, because MCP's
    Tool shape varies by protocol revision and these are the listed server's
    own public `tools/list` **(implementer's call)**.
  - 409 if the entry is `disabled` or not enabled for that instance.
- **Body caps** (here and on `PUT records/...`, 8.4): a JSON body of at most
  1 MiB and at most 500 `tools` items; over either → 413 problem+json. A
  compromised instance or publisher key must not be able to fill the store.
  (Mirrored `server` objects are bounded by upstream already.)

### 9.5 Timing and retries

- The gateway polls every **5 seconds** (R1's default; "immediately" means
  seconds). A push channel is a later option, not version 1.
- On a failed connection the gateway retries with backoff on its side and
  posts `failed` only after its own retry budget; the operator retries by
  re-PUTting the enable. The registry never schedules retries.
- Result posts are retried by the gateway with backoff until accepted
  (idempotent).

### 9.6 Visibility

Public: only `hosting: {hosted, instances}` (5.2), or nothing with
`publicHosting: "none"`. Operator reads: per instance `{instance, state,
sha256, updatedAt, notices}`. The registry's logs and audit records name
instances only by instance id and key fingerprint; no hostnames, addresses
or forwarded headers from instance requests are recorded beyond what rate
limiting needs in memory.

## 10. Authentication

### 10.1 Keys in config

- **Publisher/operator keys**: each entry `{name, algorithm: "ed25519" |
  "ecdsa-p384", publicKey, domains: [...], namespaces: [...], operate:
  bool}`. `domains` are what `mcp-publisher login dns|http --domain` sends;
  `namespaces` are claimed namespaces the key may publish into; `operate`
  allows the operator endpoints (enable, overrides, conflicts, sync now).
- **Instance keys**: each entry `{instance, algorithm, publicKey}`.
- Revocation = removing a key from config and restarting. That stops new
  exchanges at once; tokens already issued stay valid until they expire, so
  revocation takes full effect within 5 minutes of the restart (10.3). The
  operator docs say so.

### 10.2 Exchanges

- `POST /v0.1/auth/dns` and `POST /v0.1/auth/http` take upstream's exact
  payload `{domain, timestamp, signed_timestamp}` (RFC 3339 timestamp within
  ±15 s; hex signature of the timestamp). Instead of a DNS TXT lookup or a
  well-known fetch, the signature is verified against the configured key(s)
  for that domain. On success: `{registry_token, expires_at}` (upstream's
  shape). So an unmodified `mcp-publisher login dns --domain <d>
  --private-key ...` works; the DNS record is never consulted, and the
  operator docs say so.
- `POST /v0.1/x/io.github.mchen6/countinghouse-registry/auth/instance` takes
  `{instance, timestamp, signed_timestamp}`, verified against that
  instance's key; instances never use the domain exchanges.
- **Replay cache**: a successful exchange records (key fingerprint,
  timestamp) for 30 s; a repeat is refused (401). Keyed on the timestamp,
  not the signature, because ECDSA signatures are malleable (a captured
  (r, s) yields a valid (r, n−s)); the comment says so. In process memory
  (version 1 runs one process); moves to the store if that ever changes.
- **Rate limit** per source address on the exchange routes (in memory): 10
  per minute, then 429 with `Retry-After` **(implementer's call on the
  numbers)**.

### 10.3 Tokens

- HS256 JWTs made with `node:crypto` only (no JWT library), valid **5
  minutes** for every kind of token (gateways re-sign about every four
  minutes). Claims: `sub` (key name or instance id), `kind`
  (`publisher` | `instance`), `perm` (namespaces, operate, or instance id),
  `iat`, `exp`, `jti`.
- The signing secret follows countinghouse's secret-file discipline exactly
  (countinghouse `lib/identity.js`, R2-1 task 1,
  `docs/superpowers/specs/2026-11-07-r2-1-no-raw-keys-in-modules-design.md`):
  64 hex characters; generated on first start; written atomically with mode
  0600; refused if group- or world-readable or reached through a symlink;
  alternatively an environment variable in the same form; both present →
  startup refused; never logged.
- Logs and audit carry key fingerprints only, never tokens, signatures,
  keys or the secret.

## 11. Modules: package shape, generator, publish

### 11.1 The module package (countinghouse item N1, Implementer B)

Agreed with Implementer B; the spec cites B's N1 PR once open (number to be
filled in when it exists):

- `package.json`: `mcpName` (= `server.json` `name`; must match
  `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`, 3–200 characters); one `bin` entry,
  keyed by the unscoped package name, `./bin/countinghouse-launch.js`;
  `peerDependencies: {"countinghouse": "^8"}`; `files` includes `api.json`,
  `schema.json`, `handlers/`, `bin/`, `server.json`,
  `countinghouse-record.json`; `repository`; strict semver `version`.
- `bin/countinghouse-launch.js` (emitted by countinghouse's scaffold):
  resolves the peer countinghouse and runs
  `framework.js --loadModule <own package dir>` with all arguments passed
  through; forwards SIGINT/SIGTERM; exits with the child's code or signal.
  No keyless special case: like countinghouse, it writes a demo key on first
  start (to `./auth.json` in the current directory, or `--authConfigPath`)
  and prints it once; `COUNTINGHOUSE_API_KEY` selects single-key mode.
- `countinghouse-record.json` ships in the package so every operator can
  publish the record to their own registry from the installed package, and
  anyone can verify the pointer offline.
- countinghouse-validate (N1) warns on: non-strict-semver version,
  description over 100 characters, invalid `mcpName`, and a pointer hash
  that does not match the shipped record.

### 11.2 The tool-list source

`require('countinghouse/lib/mcp/tools-list-for-module').toolsListForModule(dir)`
(N1): the gateway's own tool-building code, refactored to take a module
directory without a server, port or Redis; returns `{tools}` exactly as the
gateway serves them; guarded in countinghouse by a no-drift test against
real servers for every bundled module. For a module with a run-time device
discovery handler it throws a `CountinghouseError` with code
`MODULE_DISCOVERS_DEVICES`; the generator then refuses with "run the
capture against a server" instead of emitting a wrong record. That limit is
part of version 1. (The exact signature, sync or promise, is fixed in B's
PR; the generator runs it in a child process either way, because it loads
module code.)

### 11.3 Packaging: two npm packages

This repository holds two packages as npm workspaces, both published to npm
under these names (decided by the reviewer on the maintainer's delegation):

- **`countinghouse-registry`**: the service (sections 4–10, 13). Depends on
  Express 4, ajv 8 and sqlite3.
- **`countinghouse-registry-cli`**: the generator, the publish command and
  the operator commands (11.4–12), for module authors and operators on any
  machine Node 24 runs on. Its only runtime dependencies beyond Node are
  ajv and ajv-formats (validation; both used by countinghouse); no sqlite3,
  no Express. It signs with `node:crypto`.

Code both need (the canonical hash, the `server.json` validation rules, the
record schema) lives in the CLI package and is required by the service
**(implementer's call: one copy, in the package with fewer dependencies)**.

### 11.4 `countinghouse-registry-cli generate <module dir> --registry <base URL>`

Run by the author before `npm publish` (e.g. `npx countinghouse-registry-cli generate .`):

1. Runs `countinghouse-validate --json` on the directory, with countinghouse
   resolved from the module's own install: the author has countinghouse as
   a `devDependency` alongside the peer dependency (N1's scaffold adds both);
   if it cannot be resolved → exit 2 saying so. Any problem → exit 1 with the
   problems.
2. Checks `package.json`: `mcpName` present and valid, strict semver
   `version`, `description` ≤100 characters (else exit 1 asking for one; no
   silent truncation), `bin` and `files` as 11.1.
3. Calls the export in a child `node` process; `MODULE_DISCOVERS_DEVICES` →
   exit 1 with the capture instruction.
4. Builds the record (8.1), hashes it (8.2), writes
   `countinghouse-record.json`.
5. Writes `server.json` (schema 2025-12-11):
   - `name` = `mcpName`; `description`; `version`; `title` omitted;
     `repository` from `package.json` (`source: "github"` for github.com;
     `subfolder` from `repository.directory`); `websiteUrl` from `homepage`.
   - One package: `registryType: "npm"`, `identifier` = package name,
     `version`, `runtimeHint: "npx"`, `transport: {type: "streamable-http",
     url: "http://{host}:{port}/mcp", headers: [{name: "X-CH-Key",
     description: <B's text>, isRequired: true, isSecret: true}]}`,
     `packageArguments`: named `--port` (`valueHint: "port"`, format number,
     default 9527) and `--bindAddr` (`valueHint: "host"`, default
     127.0.0.1), `environmentVariables`: `COUNTINGHOUSE_API_KEY`
     (`isRequired: false`, `isSecret: true`, description saying the same
     value is sent as `X-CH-Key`). Same shape as countinghouse's own
     `server.json` after N1.
   - The pointer (8.3) in `publisher-provided`.
6. Validates the emitted `server.json` with the same code as 7.5 (offline)
   and exits 0.

### 11.5 `countinghouse-registry-cli publish <module dir> --registry <base URL> --domain <d> --key <path>`

Signs a dns-style exchange (10.2), PUTs `countinghouse-record.json` (8.4),
then POSTs `server.json` to `/v0.1/publish`. The registry enforces the order
through 7.5 rule 4. The private key is read from the file given, or an
environment variable; it is never printed. `npm publish` and any push to the
official registry (with `mcp-publisher`) stay the author's separate steps.

`mcp-publisher publish` against this registry also works, for a
`server.json` whose record was PUT beforehand or one without a pointer.

## 12. Operator commands

`countinghouse-registry-cli` offers thin wrappers over the operator
endpoints (enable, disable, list enabled with results and history,
conflicts, acknowledge, overrides, sync now), signing like 11.5
**(implementer's call: the operator API is usable without them; they exist
so no operator hand-signs JWTs)**.

## 13. Service

### 13.1 Process

One Node process: Express 4 app (read API, publish, auth, extension
routes), the mirror scheduler, the in-memory replay cache and rate limiter.
Binds `127.0.0.1:9800` by default **(implementer's call on the port)**;
TLS and public exposure are the operator's reverse proxy's job (operator
docs). Graceful shutdown on SIGTERM: stop accepting, let the current mirror
page finish, close the store.

### 13.2 Config

One JSON file (path by `--config`), validated at start with an ajv 2020-12
schema; any error refuses startup with the field path. It holds: listen
address and port; the upstreams with their intervals and reconciliation
schedules (6.8); claimed namespaces;
publisher/operator keys; instance keys; `publicHosting`; the store path; the
JWT secret file path (`secret.file`, by default `.jwt-secret` beside the
store **(implementer's call)**; or the environment variable, per 10.3).

### 13.3 Store

One SQLite file (sqlite3 `^6`, WAL mode). Tables, at least: records
(source, name, version, server JSON, official meta, our overlays, `changedAt`,
the serving upstream), every upstream's copies (6.8: upstream, name, version,
server JSON, official meta, last seen by a reconciliation pass, hidden mark),
mirror state per upstream (cursor, checkpoint, last run, last reconciliation
count, shrink-guard decision), conflicts, overrides, countinghouse records
(name, version, JSON, sha256), enables per (instance, name, version) with
state and timestamps, instance results as **history** (outcome, sha256 or
reason, time), audit (operator actions: who by fingerprint, what, when).
Indexes: (name, version) unique per served record, `changedAt`, the FTS5
trigram table on names.

Claimed namespaces changing between restarts **(implementer's call)**: an
added claim recomputes `isLatest` (7.4) for the affected names at startup; a
removed claim that still has local records refuses startup, listing the
names, so the operator resolves it explicitly. Schema migrations versioned from day
one. sqlite3's prebuilt binding needs glibc ≥ 2.38 (as countinghouse
documents); it is a hard dependency here, and the install docs say so.

Backups: the SQLite file and its WAL are the registry's only state; the
operator docs give a consistent backup (the SQLite online backup API, or a
copy after a checkpoint) and say that losing it means a full re-sync plus
re-publishing local records and re-enabling.

### 13.4 Health

`GET /healthz` (internal: for the orchestrator's or proxy's health check,
never exposed publicly; the operator docs say so): 200
`{ok: true, store: "ok", mirror: <6.5 aggregate>, upstreams: [<6.5 per upstream>]}`
when the store answers; 503 with `store: "error"` when it does not (`/v0.1/health` answers
503 `{status: "error"}` in the same case).
A failed mirror alone does not make it 503 (the API still serves).

### 13.5 Logs

countinghouse's approved log record shape from day one (one JSON object per
line: `t`, `level`, `event`, `msg`, `source`, ...; same field names; secrets
excluded by construction), per countinghouse's
`docs/superpowers/specs/2026-11-09-logger-design.md`. No shared code yet: a
copy of the record definition with its origin named.

## 14. Testing

- TDD throughout (the brief): every change starts with a failing test.
- **Read-API conformance**: fixtures recorded from the live official API
  (2026-11-10) for response shapes, error bodies and parameter errors; our
  responses compared structurally.
- **Ported validation rules**: upstream's own validator test cases
  (`internal/validators/*_test.go` at `7e8fa024`, inputs and expected rule
  ids) as fixtures in CI, with the commit in a header.
- **"Publishable upstream" invariant**: (a) the CI fixtures above; (b) a
  manual pre-release script that posts our "valid here" fixtures to the
  official `POST /v0.1/validate` (no auth) and checks each is valid. Never in
  CI.
- **Hash parity**: our canonical hash of countinghouse's
  `echo-device-module.json` fixture equals countinghouse's (8.2). Until N1
  adds that fixture, the test runs against the test vectors of
  countinghouse's existing `output-schema-hash` tests.
- **Copies from countinghouse** (`output-schema-hash.js`, the log record
  definition, fixtures) are taken by reading `~/countinghouse` at a pinned
  commit named in each copied file's header; countinghouse is never a
  dependency of the service, and the generator resolves it from the module's
  own install **(implementer's call)**.
- **Mirror**: the upstream client takes an injected HTTP function, so sync,
  resume, overlap, dedupe, deleted handling, 429/`Retry-After` and backoff
  are tested without network or ports.
- **Auth**: exchange success, wrong key, skew, replay (including the ECDSA
  (r, n−s) case), rate limit, token expiry, permission scoping.
- **Secrets**: no token, signature, key or secret in any log line (a test
  scans captured logs).
- Tests that listen on a port use 9700–9719 under the shared lock
  (`~/countinghouse/.superpowers/suite.lock`), per the brief; HTTP tests
  prefer in-process request injection so they need no port.
- CI: GitHub Actions on Node 24.15.0, 24 and 26, set up in the first code
  PR.

## 15. Cross-repository dependencies

| Item | Repo, owner | What this repo needs | Until it lands |
|---|---|---|---|
| N1 | countinghouse, Implementer B | package shape, launcher, `toolsListForModule`, fixtures, validator warnings, countinghouse's own `server.json` on 2025-12-11 | the generator is built against the agreed interface with the recorded fixtures |
| R1 | countinghouse, queued by the reviewer | the gateway as an MCP client for enabled remote entries, against section 9 | the registry side is built and tested against the contract with a fake gateway |

## 16. Differences from the official registry (documented for operators)

1. Publishing auth: dns/http exchanges verified against configured keys, not
   DNS or well-known files; github, github-oidc, oidc and none not served;
   replay cache.
2. No package-ownership check on publish (operator-only version 1).
3. Only schema 2025-12-11 accepted on publish.
4. `PUT`/`DELETE` of versions not implemented (501); status changes on
   mirrored records refused (409).
5. List order bytewise; cursor format different (opaque either way).
6. `updated_since` filters on our local `changedAt` (a deliberate superset,
   4.1).
7. Mirrored records that vanish upstream without a deleted status are hidden
   after a reconciliation pass (6.6).
8. Several upstreams may be mirrored, the first in the list winning (6.8);
   `isLatest` is recomputed only for names served from more than one.
9. Our `_meta` key and the extension endpoints.

## 17. Left to the builder, and the implementer's calls

Left to the builder: the cursor encoding; table layouts beyond 13.3; module
layout of the code; the exact problem `title` strings beyond those quoted;
the mirror's internal batching within a page; the config file's field names
(13.2 lists the content).

The implementer's calls in this spec (each changeable at review):

1. Status `PATCH` on mirrored records → 409; overrides are the operator's
   tool for mirrored entries (4.2).
2. `PUT`/`DELETE` of versions → 501 (4.2).
3. Exchange rate limit numbers: 10 per minute per source (10.2).
4. Operator wrapper commands in the bin (12).
5. Default listen port 9800 (13.1).
6. `sse` remotes not enableable in version 1 (9.3).
7. Failure reason codes for results (9.4) and mirror error codes (6.5).
8. Backoff parameters: 5 s base, full jitter, capped at the interval (6.4).
9. The gateway poll watermark `nextSince` issued by the registry (9.4); its
   form, a change sequence rather than a time, is the reviewer's correction.
10. Tool items in results and records: `name` and `inputSchema` required,
    otherwise open; `permissions` any object (8.4, 9.4).
11. Shared code lives in the CLI package and is required by the service
    (11.3).
12. Claimed-namespace changes between restarts: recompute on add, refuse
    startup on removal with local records (13.3).
13. Copies from countinghouse at a pinned commit; countinghouse never a
    service dependency (14).
14. Several upstreams (6.8): an empty upstream list means no mirroring;
    a deleted copy at a higher-precedence upstream is served as deleted; a
    changed `url` drops that upstream's copies and restarts it with a first
    sync.

## 18. Later (not version 1)

Listed so the roadmap is visible; none of it is built in version 1.

- **Tool-surface scan**: a rules-based scan of a `tools/list` (injection
  phrases, requests for secrets, hidden instructions), run on enable, on every
  `changed`, and before publish, with one rules file shared with
  countinghouse-validate under the copy rule.
- **Read-API conformance monitor**: a scheduled job (GitHub Actions cron)
  replaying a sample of requests against the official registry and a
  deployed instance, with the diff kept as an artifact.
- **`connect` command**: prints connection snippets per MCP client for an
  entry.
- **`status` command**: joins the registry's validation state with gateway
  health and usage.
- **Author self-publishing**, with the package-ownership check restored
  (7.5).
- **Supply-chain recording** (digest, provenance result) once package
  entries are hosted.
- **Read-only web console** (catalogue, enabled entries per instance,
  usage): after the pilot and before charging; a static page in this
  repository over the existing API.
- **Upstream OAuth and client-facing OIDC** are countinghouse's
  first-paid-version items; version 1's remote `headers` are the gateway's
  static credentials.
