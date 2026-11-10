# Research: the official MCP Registry as of 2026-11-10

Input for the countinghouse-registry spec. Primary sources only: the official
registry repository (docs, OpenAPI, Go source), the published schemas, the
live API, the issue tracker and the MCP specification repository. Every
statement below carries its source; where docs and code disagree, both are
quoted and the code (what runs in production) is called out.

## Sources and versions

| Source | Version read |
|---|---|
| Repository `github.com/modelcontextprotocol/registry` | `main` at `7e8fa024` (2026-11-10); latest release **v1.8.9** (tag `ba94f657`, published 2026-11-10T11:08Z) |
| Live service `https://registry.modelcontextprotocol.io` | `GET /v0.1/version` → `{"version":"1.8.9","git_commit":"ba94f657…","build_time":"2026-11-10T11:14:06Z"}` |
| API specification | `docs/reference/api/openapi.yaml`, `info.version: "2025-12-01"`, OpenAPI 3.1 |
| server.json schema (current) | `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (`model.CurrentSchemaVersion = "2025-12-11"` in `pkg/model/constants.go`) |
| Published schema versions | `github.com/modelcontextprotocol/static/schemas`: 2025-07-09, 2025-08-26, 2025-09-16, 2025-09-29, 2025-10-11, 2025-10-17, 2025-12-11 |
| Changelogs | `docs/reference/api/CHANGELOG.md`, `docs/reference/server-json/CHANGELOG.md` |
| Publisher CLI | `cmd/publisher` (`mcp-publisher`), `docs/reference/cli/commands.md` |
| MCP spec repository | SEP-2127 "MCP Server Cards" (`seps/2127-mcp-server-cards.md`, merged 2026-10-06) |

Paths below are relative to the registry repository unless stated.

## 1. Status: what is stable, what is still moving

- **Still "preview".** README: launched in preview 2025-09-08; "breaking
  changes or data resets may occur". The same `<Note>` heads every page in
  `docs/modelcontextprotocol-io/`. There is no GA date. `docs/design/roadmap.md`
  says its phase labels are "out of date as of 2026-08-10" and points to issues.
- **`/v0.1` is frozen, additive only.** README (2025-10-24): "API freeze
  (v0.1) … no breaking changes". API changelog 2025-10-17: "`/v0.1/` will
  remain stable with only additive, backward-compatible changes"; `/v0/`
  "continues as the development version"; "Both versions will be maintained
  until a future v1.0 release". Both prefixes are served by the same handlers
  (`internal/api/handlers/v0/*.go`, registered per `pathPrefix`) and both answer
  in production today.
- **The freeze has not stopped behaviour changes at the edges.** Since the
  freeze, the official service: made `search` require ≥3 characters (422
  otherwise; `official-registry-api.md` says "This restriction changes
  previously accepted one- and two-character searches"); allowed several server
  names to share one remote URL (API changelog "Unreleased", marked
  ⚠️ BREAKING for consumers that index by URL); added status endpoints and
  `statusMessage`/`statusChangedAt` (additive).
- **server.json moves by dated schema versions.** Seven published versions in
  five months of 2025, none in 2026. The draft adds one relaxation (transport
  URLs may start with a template variable, PR #910, 2026-02-09) that is **not**
  in 2025-12-11 (`internal/validators/schemas/2025-12-11.json` keeps
  `"pattern": "^https?://[^\\s]+$"`). Package type `cargo` was added in code
  2026-06-03 (#1207) without a new schema version (the 2025-12-11 `registryType`
  is a free string; only its description lists types).
- **Open work labelled `v1`: 19 issues.** The ones that touch us:
  - #842 *Upgrade JSON schema version to 2020-12* (open; a maintainer comment
    plans to switch the extractor's dialect from draft-07 to 2020-12).
  - #622 *Clarify approach to managing server.json schema versions* (open).
  - #84 *Include ServerCapabilities in server.json* (open; relabelled v1,
    "most of the substance … is being worked upstream", pointing at SEP-2127).
  - #604 *Support OIDC login from publisher CLI for subregistries* (open).
  - #744 *`/.wk/mcp-registry-auth` ⇒ `/.wk/mcp/registry-auth`* (open).
  - #480 *contact_email field*, #124 *array of commands*, #657 *`prefix` on
    NamedArgument* (all open; would be additive schema fields).

Summary table:

| Area | State |
|---|---|
| Read endpoints, paths, parameters, response envelope (`/v0.1`) | Frozen (additive only) since 2025-10-24 |
| Official-only query semantics (`search` length, ordering, URL sharing) | Changed after the freeze; documented as official-registry behaviour |
| server.json 2025-12-11 | Current; unchanged for 11 months |
| server.json draft | Small additive relaxation pending; dialect change to 2020-12 planned (#842) |
| Publishing auth | Official: custom JWT "for legacy reasons"; generic spec says registries SHOULD use MCP OAuth 2.1 instead |
| `/v0.1/x/…` extensions | Convention only; no discovery endpoint |
| v1.0 of the API | Not started publicly; 19 `v1` issues open |

## 2. The read API

Source: `docs/reference/api/generic-registry-api.md`,
`official-registry-api.md`, `openapi.yaml`, `internal/api/handlers/v0/servers.go`.

### Endpoints (generic API, required for a subregistry)

- `GET /v0.1/servers` — list, one record **per server version**.
- `GET /v0.1/servers/{serverName}/versions` — all versions of one server.
- `GET /v0.1/servers/{serverName}/versions/{version}` — one version;
  `version = latest` is special.

`serverName` and `version` are URL-encoded path segments
(`io.github.user%2Fweather`; versions with `+` as `%2B`). The official handler
calls `url.PathUnescape` on both (`servers.go`). All bodies are
`application/json`. Reads need no authentication ("public for reading",
`registry-authorization.md`).

### `GET /v0.1/servers` parameters

| Param | Generic spec | Official behaviour (code) |
|---|---|---|
| `cursor` | opaque string from `metadata.nextCursor` | value is `"<name>:<version>"` of the last row (`postgres.go` `addCursorCondition`) — clients must treat it as opaque |
| `limit` | integer | default **30**, min 1, max **100** (`ListServersInput`) |
| `search` | substring on name | case-insensitive substring on `name`; nonempty must be ≥3 Unicode chars after trim, else **422** |
| `updated_since` | RFC 3339 | invalid → **400**; forces `include_deleted=true`; explicit `include_deleted=false` with it → **400** |
| `version` | `latest` or exact | `latest` filters `isLatest = true`; otherwise exact string match |
| `include_deleted` | boolean, default false | as stated |

Ordering (official, code and `openapi.yaml`): by server name, then version
string, both ascending, **as text** (`ORDER BY server_name, version` in
PostgreSQL, i.e. the database collation, not byte order and not semver).
`/versions` is ordered by `published_at DESC`.

### Response shapes (live, 2026-11-10)

```json
{
  "servers": [
    {
      "server": {
        "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        "name": "ac.mizan/registry",
        "description": "…",
        "title": "Mizan",
        "version": "1.2.0",
        "websiteUrl": "https://mizan.ac/capabilities",
        "icons": [{ "src": "https://mizan.ac/icon-512.png", "mimeType": "image/png", "sizes": ["512x512"] }],
        "remotes": [{ "type": "streamable-http", "url": "https://mizan.ac/mcp" }]
      },
      "_meta": {
        "io.modelcontextprotocol.registry/official": {
          "status": "active",
          "statusChangedAt": "2026-11-05T23:35:33.188176Z",
          "publishedAt": "2026-11-05T23:35:33.188176Z",
          "updatedAt": "2026-11-05T23:35:33.188176Z",
          "isLatest": true
        }
      }
    }
  ],
  "metadata": { "nextCursor": "ac.mizan/registry:1.2.0", "count": 2 }
}
```

- `ServerResponse` = `{ server: ServerDetail, _meta: { … } }`. The
  `ServerDetail` is the published server.json. The response-level `_meta` is
  registry-managed; in `openapi.yaml` it has `additionalProperties: true`, and
  only `io.modelcontextprotocol.registry/official` is defined (that object is
  `additionalProperties: false`, fields `status`, `statusMessage` ≤500,
  `statusChangedAt`, `publishedAt`, `updatedAt`, `isLatest`).
- `/versions` returns the same `ServerList` envelope, `metadata.count` only.
- End of list: `nextCursor` null, empty or absent.

### Errors: docs and production disagree

`openapi.yaml` documents error bodies as `{ "error": "Server not found" }`.
Production answers RFC 9457 problem details (huma's `ErrorModel`):

```
HTTP/2 404
content-type: application/problem+json
{"title":"Not Found","status":404,"detail":"Server not found"}
```

**Which one is served (checked 2026-11-10 against v1.8.9 @ `ba94f657`):**
production sends problem details. Requests used:

```
curl -s -i 'https://registry.modelcontextprotocol.io/v0.1/servers/nope%2Fnope/versions/latest'
  → 404, application/problem+json, {"title":"Not Found","status":404,"detail":"Server not found"}
curl -s -i --compressed 'https://registry.modelcontextprotocol.io/v0.1/servers?search=ab'
  → 422, application/problem+json, {"title":"Unprocessable Entity","status":422,
     "detail":"search must contain at least 3 characters after trimming surrounding whitespace"}
```

A compatible implementation should follow production; clients written
against the OpenAPI text would only find `error` missing. This must be
re-checked whenever the deployed version changes.

### Optional write endpoints in the generic spec

All `bearerAuth`, "registry-specific" token:

- `POST /v0.1/publish` (body: `ServerDetail`, returns `ServerResponse`;
  501 if unsupported).
- `PUT /v0.1/servers/{name}/versions/{version}` (edit one version; the
  official registry has it as an **admin** endpoint — `official-registry-api.md`;
  `openapi.yaml` still says "not implemented by the official MCP registry").
- `DELETE /v0.1/servers/{name}/versions/{version}` (not implemented by the
  official registry).
- `PATCH /v0.1/servers/{name}/versions/{version}/status` and
  `PATCH /v0.1/servers/{name}/status` (body `{status, statusMessage?}`;
  `statusMessage` not allowed with `active`; bulk returns
  `{updatedCount, servers}`).

### Official-only service endpoints (not in `openapi.yaml`)

`POST /v0.1/validate` (used by `mcp-publisher validate`), `GET /v0.1/ping`,
`GET /v0.1/version`, `GET /v0.1/health`, `GET /metrics`, and the auth
exchanges in section 5.

### Extension endpoints

`docs/reference/api/extensions.md`: non-core features live at
`/v0.1/x/<reverse-dns-namespace>/<extension>[/<path>]`; registries SHOULD
namespace; clients MUST tolerate their absence; list endpoints should reuse the
core cursor pagination. No discovery endpoint yet ("Future Considerations").

## 3. server.json

Source: `docs/reference/server-json/generic-server-json.md`,
`official-registry-requirements.md`, `CHANGELOG.md`, the schema files,
`openapi.yaml` components.

### Dialect

Every published schema, 2025-07-09 through 2025-12-11, declares
`"$schema": "http://json-schema.org/draft-07/schema#"` (checked in
`internal/validators/schemas/*.json` and the live 2025-12-11 file). The OpenAPI
document declares `jsonSchemaDialect: 2020-12`, but the extracted server.json
schema is draft-07; #842 plans to change that. The official validator uses
`santhosh-tekuri/jsonschema/v5` and picks the schema file **by the `$schema`
URL in the document** (`internal/validators/schema.go`); a missing `$schema`
is an error; a non-current version is handled by policy (error / warn / allow).

### `ServerDetail` fields (2025-12-11)

| Field | Rule |
|---|---|
| `name` | required; 3–200 chars; `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`; reverse-DNS namespace, exactly one `/` |
| `description` | required; 1–100 chars |
| `version` | required; ≤255; must not look like a range (`^`, `~`, `>=`, `1.x`, `1.*`, `1 - 2`, `\|\|`); `latest` reserved |
| `title` | optional; 1–100; not whitespace-only |
| `repository` | optional `{url (uri), source, id?, subfolder?}` |
| `websiteUrl` | optional absolute http(s) URI |
| `icons[]` | optional `{src (https, ≤255), mimeType? (png/jpeg/jpg/svg+xml/webp), sizes? (WxH or any), theme? (light/dark)}` |
| `$schema` | the schema URL |
| `packages[]` | see below |
| `remotes[]` | see below |
| `_meta` | object; only `io.modelcontextprotocol.registry/publisher-provided` is defined |

A server may have packages, remotes, both, or (schema-wise) neither; issue
#1579 reports 387 active official entries with neither.

### Package entries ("run it locally")

`{registryType, identifier, transport, version?, registryBaseUrl?, fileSha256?,
runtimeHint?, runtimeArguments[]?, packageArguments[]?, environmentVariables[]?}`

- `registryType`: `npm`, `pypi`, `nuget`, `oci`, `mcpb`, `cargo` (constants
  in `pkg/model/constants.go`).
- npm/pypi/nuget/cargo: `identifier` = package name, `version` required in
  practice. oci: `identifier` = full image reference with tag. mcpb:
  `identifier` = download URL, `fileSha256` required.
- `transport`: `stdio`, `streamable-http` or `sse` (the HTTP ones with a `url`
  template whose `{vars}` refer to the package's arguments/env vars).
- Arguments: `positional` (`value` or `valueHint`) or `named` (`name` is the
  flag); both carry the `Input` fields (`description`, `isRequired`, `format`
  string/number/boolean/filepath, `value`, `isSecret`, `default`,
  `placeholder`, `choices`, `variables`).
- Official-only: base URLs restricted (npm only `https://registry.npmjs.org`,
  etc.), and **ownership verification** per type: for npm, the package's
  `package.json` must carry `"mcpName": "<server name>"`
  (`docs/modelcontextprotocol-io/package-types.mdx`).

Example (from `versioning.mdx`):

```json
{
  "version": "1.2.3",
  "packages": [{
    "registryType": "npm",
    "identifier": "@my-username/my-server",
    "version": "1.2.3",
    "transport": { "type": "stdio" }
  }]
}
```

### Remote entries ("connect to it")

`remotes[]` items: `{type: "streamable-http" | "sse", url, headers[]?,
variables{}?}` (`docs/modelcontextprotocol-io/remote-servers.mdx`).

- `url` (2025-12-11): `^https?://[^\s]+$`; may contain `{var}` templates
  defined in `variables` (multi-tenant hosts, regions).
- `headers[]`: `KeyValueInput` — `{name, description, isRequired, isSecret,
  value?, …}`; e.g. an API key header the client must fill.
- SSE is deprecated in MCP; publish it only for old clients.
- "A remote server **MUST** be publicly accessible at its specified URL." The
  registry does **not** verify control of the remote URL, only of the name's
  namespace; several names may now share one URL; consumers must key records
  by name + version, never by URL.

```json
{
  "remotes": [{
    "type": "streamable-http",
    "url": "https://analytics.example.com/mcp",
    "headers": [{ "name": "X-API-Key", "isRequired": true, "isSecret": true }]
  }]
}
```

### `_meta`: where third-party data may go

Two different `_meta` objects exist (`official-registry-requirements.md`):

1. **`server._meta`** (inside server.json, publisher-controlled). The official
   registry keeps **only** `io.modelcontextprotocol.registry/publisher-provided`
   and *silently drops every other key* (the Go type `ServerMeta` has that one
   field). Limit: 4096 bytes of marshalled JSON, else publish fails. Namespaced
   subkeys inside it are recommended, not enforced
   (`"io.example.ci-publisher": {…}`).
2. **Response-level `_meta`** (registry-managed, outside `server`). Publishers
   cannot set it. The OpenAPI allows extra keys; `registry-aggregators.mdx`
   ("Acting as a Subregistry") says subregistries may inject custom metadata
   "under a key that reflects the subregistry (e.g.
   `com.example.subregistry/custom`)". Note: that page's example shows the
   custom key inside the server.json `_meta`, not at response level; the
   OpenAPI `ServerDetail._meta` does not forbid extra keys either (no
   `additionalProperties: false`), so both placements validate against the
   schema. Only the official registry strips them.

### Versions and "latest"

- A version string is unique per server and **immutable** once published
  ("Once published, the version string (and other metadata) cannot be
  changed", `versioning.mdx`); only `status` changes for publishers. Admins can
  still edit a version (`PUT`), which moves `updatedAt`.
- Up to 10 000 versions per server (`maxServerVersionsPerServer`).
- `isLatest` (code, `internal/service/versioning.go` `CompareVersions`): both
  semver (strict `MAJOR.MINOR.PATCH`) → semver order; neither semver → later
  `publishedAt` wins; one semver → **the semver one wins**. Deleted versions
  are skipped when recomputing latest, unless all are deleted.
  `versioning.mdx` says instead "If parsing fails, the version will always be
  marked as latest" — the code does not do that when a semver version exists.
  `versioning.mdx` § "Aggregator Recommendations" gives the same order as the
  code (plus: a version marked latest wins).
- **Which one is served (checked 2026-11-10 against v1.8.9 @ `ba94f657`):**
  the code's rule. In the crawled catalogue, three servers have a non-semver
  version published *after* a semver one, and in all three the semver version
  kept `isLatest` (`finance.orbt/intelligence`, `com.getuserfeedback/mcp`,
  `ai.magnemo/magnemo`). Direct check:

  ```
  curl -s --compressed 'https://registry.modelcontextprotocol.io/v0.1/servers/finance.orbt%2Fintelligence/versions'
    → 3.3.0.1  publishedAt 2025-11-06T02:30:03Z  isLatest false   (not strict semver: four parts)
      3.3.0    publishedAt 2025-11-06T02:28:08Z  isLatest true
  curl -s --compressed 'https://registry.modelcontextprotocol.io/v0.1/servers/finance.orbt%2Fintelligence/versions/latest'
    → version 3.3.0
  ```

  The rule holds only while this code is deployed; a mirror should copy the
  upstream `isLatest` for mirrored records rather than recompute it (see
  section 8).

## 4. Mirroring: aggregators and subregistries

Source: `docs/modelcontextprotocol-io/registry-aggregators.mdx`,
`docs/design/ecosystem-vision.md`.

- MCP registries are **metaregistries**: metadata only, code stays in npm,
  PyPI, OCI registries. The official roadmap lists as out of scope: source
  hosting, server hosting, a unified runtime, rankings, curation, tags.
- **Aggregator** = any downstream consumer that copies the data;
  **subregistry** = an aggregator that also serves the same OpenAPI, so MCP
  hosts can read it through the standard interface, and may add metadata.
- The official API is unauthenticated, read-only for this purpose, and gives
  **no uptime or durability guarantee**. Expected scrape cadence: "regular but
  infrequent … e.g., once per hour"; persist locally; never proxy user
  requests to it.
- Sync recipe (verbatim requirements of the page): initial full paginated
  download of `GET /v0.1/servers`; afterwards `updated_since=<checkpoint>`;
  keep the same timestamp while following every `nextCursor`; save the new
  checkpoint only after all pages applied; keep a small overlap between
  windows; dedupe by name + version; incremental results include deleted
  servers — apply their status; negotiate HTTP compression; back off on
  failure or rate limiting rather than restarting full crawls.
- Status: metadata is "generally immutable, except for the `status` field";
  `deleted` usually means a moderation removal (spam, malware, illegal);
  aggregators "may prefer to remove these servers".
- Each record identifies itself by `name` + `version`; when combining sources,
  also by registry (API changelog, shared-URL entry).

Catalogue size today: see the measurement at the end of this note.

## 5. Publishing and its authentication

Source: `docs/modelcontextprotocol-io/authentication.mdx`,
`docs/reference/cli/commands.md`, `docs/reference/api/registry-authorization.md`,
`cmd/publisher`, `internal/api/handlers/v0/auth`.

### Generic recommendation

Registries that authenticate SHOULD act as an **OAuth 2.1 resource server**
per the MCP Authorization specification, so MCP clients reuse their MCP auth.
Suggested scopes `mcp-registry:read` and `mcp-registry:write`; per-namespace
authorization on top of scopes.

### What the official registry does ("custom JWT … for legacy reasons")

1. The client proves an identity at an exchange endpoint and receives
   `{"registry_token": "<JWT>", "expires_at": <unix seconds>}`:
   - `POST /v0.1/auth/github-at` — GitHub access token (device flow) →
     `io.github.<user or org>/*`.
   - `POST /v0.1/auth/github-oidc` — GitHub Actions OIDC token.
   - `POST /v0.1/auth/dns` — signed challenge; key in a TXT record
     `v=MCPv1; k=ed25519|ecdsap384; p=<public key>` on the domain → `com.example/*`
     (and subdomains).
   - `POST /v0.1/auth/http` — same proof at
     `https://<domain>/.well-known/mcp-registry-auth` → that domain only.
   - `POST /v0.1/auth/oidc` — Google OIDC, admins.
   - `POST /v0/auth/none` — anonymous, only when `EnableAnonymousAuth`
     (development/test), grants `io.modelcontextprotocol.anonymous/*`.
2. The JWT carries permissions `{action: publish|edit, resourcePattern}`;
   calls send `Authorization: Bearer <JWT>`.
3. On publish the server checks the namespace permission, validates
   server.json (schema + semantic rules), verifies package ownership, applies
   the `_meta` filter and size limit, and computes `isLatest`.

### `mcp-publisher` (the publisher CLI)

Commands: `init` (template from `package.json` etc.), `login <github |
github-oidc | dns | http | none> [--registry=URL]`, `validate [file]`,
`publish [file]`, `status --status <active|deprecated|deleted> [--message]
[--all-versions] <name> [version]`, `logout`. The token and the registry URL
are stored in `~/.config/mcp-publisher/token.json`; `--registry` exists on
`login` only.

**The CLI calls `/v0/…`, not `/v0.1/…`:** `v0/publish`
(`commands/publish.go`), `v0/validate` (`commands/validate.go`),
`v0/servers/{name}[/versions/{version}]/status` and the two read endpoints
with `include_deleted=true` (`commands/status.go`), `v0/auth/none`,
`v0/auth/github-at`, `v0/auth/github-oidc`, `v0/auth/dns|http`
(`auth/common.go`) and `v0/health` (`auth/github-at.go`).
A registry that wants to accept `mcp-publisher` must serve those `/v0` paths
and the token-exchange response shape. #604 (open, `v1`) asks for OIDC login
against subregistries; today the CLI's login methods are the official ones.

## 6. Upstream context: MCP Server Cards (SEP-2127)

`seps/2127-mcp-server-cards.md` in `modelcontextprotocol/modelcontextprotocol`:
Status **Final**, **Extensions Track**, identifier
`io.modelcontextprotocol/server-card`, merged 2026-10-06. The wire format lives
in `modelcontextprotocol/experimental-ext-server-card` (`schema.ts`).

- A Server Card describes a **remote** server only (identity, remote
  endpoints, headers, variables, supported protocol versions, namespaced
  `_meta`); recommended location `<streamable-http-url>/server-card`; can be
  listed in an AI Catalog at `/.well-known/ai-catalog.json`.
- "The Registry owns [server.json]"; the card reuses compatible field names
  where concepts overlap.
- It **deliberately excludes tools/resources/prompts and capabilities**:
  "MCP servers are inherently dynamic … A static document cannot reliably
  represent this surface"; a follow-on SEP should define variants and
  consumer contracts first. `_meta` "is not a substitute for standardized
  capability or extension fields".

## 7. Consequences for countinghouse-registry (facts, not decisions)

These follow from the sources above; the choices are for the spec.

1. **Target `/v0.1`** (frozen) and decide whether to also serve `/v0` as an
   alias: the official registry serves both from one handler set, and
   `mcp-publisher` only speaks `/v0`.
2. **Errors as `application/problem+json`** to match production, not the
   OpenAPI text.
3. **Opaque cursors** are allowed; the official `name:version` form and its
   collation-dependent order need not be copied, but the sort keys (name, then
   version as text) and per-version records should be.
4. **Schema dialect mismatch with our stack.** server.json is draft-07 today
   and may become 2020-12 (#842). countinghouse validates with ajv 8 in
   2020-12 mode; ajv needs a separate instance per dialect (`ajv` for
   draft-07, `ajv/dist/2020` for 2020-12). Validation must pick the schema by
   the document's `$schema` URL, as the official validator does, and vendor
   the published schema files (2025-12-11 at least) rather than fetch them at
   run time.
5. **Semantic rules beyond the schema** exist (range-like versions,
   `latest` reserved, URL checks, argument rules, `_meta` size); a compatible
   validator needs them, sourced from `internal/validators/validators.go`.
6. **Where countinghouse data can live.**
   - Data the module author declares (tool surface, permissions, pricing,
     composition targets) is publisher data: it belongs in server.json `_meta`.
     If the same server.json is also published to the official registry, only
     `io.modelcontextprotocol.registry/publisher-provided` survives there, with
     a **4 KB** limit — a full golden `tools/list` will not fit in many cases.
   - Data the registry knows (hosting status of an instance, validation
     result) is registry-managed: response-level `_meta` under our own
     reverse-DNS key, which official clients ignore.
7. **Static tool surfaces go against current upstream direction.** SEP-2127
   excludes tool lists on purpose; #84 is open. A countinghouse golden is a
   validated contract for a version, which is a stronger claim than a
   self-declared list, but the spec should say what consumers may rely on.
8. **Mirroring is a polling job**: hourly-ish, `updated_since` checkpoints with
   overlap, dedupe on name + version, apply `deleted`/`deprecated`, keep the
   official `_meta["io.modelcontextprotocol.registry/official"]` of mirrored
   records, and expect no availability guarantee upstream. Records from two
   sources must be keyed by (source, name, version); names may collide only
   if we let operators publish into namespaces that the official registry also
   holds — a policy question for the spec.
9. **Operator-only publishing** fits the generic spec: `POST /v0.1/publish` and
   the status/edit endpoints are optional and "authentication mechanism is
   registry-specific". Reusing `mcp-publisher` would require the `/v0`
   exchange endpoints; a bearer operator token on our own CLI or the generator
   is simpler. The generic recommendation for a later author-facing flow is
   OAuth 2.1 (MCP authorization).
10. **`latest` rules**: for records we publish ourselves, implement the
    deployed rule (the code's `CompareVersions`, verified live above), not the
    sentence in `versioning.mdx`; for mirrored records, keep upstream's
    `isLatest`.
11. **countinghouse module as a package entry**: `registryType: "npm"` with
    `transport: stdio` and `runtimeHint: "npx"` plus `runtimeArguments` can
    express the `npx countinghouse --loadModule` run form; the official
    registry would additionally require `mcpName` in the module's
    `package.json`. A hosted instance is a `remotes[]` entry
    (`streamable-http`, likely with a key header marked `isSecret`).

## 8. What a compatible registry must reproduce vs what we add

The base the spec builds on. "Must" here means: required for an unmodified
client or subregistry that reads the official registry to read ours.

### Must reproduce

| Area | Exactly what |
|---|---|
| Read paths | `GET /v0.1/servers`, `GET /v0.1/servers/{name}/versions`, `GET /v0.1/servers/{name}/versions/{version}` with `latest`; URL-encoded path segments (`%2F` in names, `%2B` in versions) |
| List parameters | `cursor`, `limit` (default 30, max 100), `search` (case-insensitive substring on name, ≥3 chars else 422), `updated_since` (RFC 3339, else 400; implies `include_deleted=true`, 400 if explicitly false), `version` (`latest` or exact), `include_deleted` |
| Pagination | opaque `metadata.nextCursor`; end of list when it is null, empty or absent; `metadata.count` = items in the page; the same filters apply across pages |
| Records | one record per server version; `{server: <server.json as published>, _meta: {"io.modelcontextprotocol.registry/official": {status, statusMessage?, statusChangedAt, publishedAt, updatedAt, isLatest}}}`; list order by name then version (text); `/versions` by `publishedAt` descending |
| Status semantics | `active` / `deprecated` / `deleted`; deleted hidden unless `include_deleted`; a deleted version never `latest` while a non-deleted one exists |
| Errors | `application/problem+json` `{title, status, detail}` as production sends it (section 2), with the same codes: 400 bad parameter or encoding, 404 `"Server not found"`, 422 short search |
| Accepted schema | server.json `$schema` = `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, **draft-07** dialect, validated by the document's `$schema` URL; older published versions by policy (official: error/warn/allow); a 2020-12 version must be expected (#842) |
| Semantic validation | the official non-schema rules (version not a range and not `latest`, name format, URL and argument rules, template variables defined) |
| Versions | `name` + `version` unique and immutable after publish; only status (and operator edits) change a record |
| `_meta` in server.json | the official registry keeps only `io.modelcontextprotocol.registry/publisher-provided`, ≤4096 bytes of JSON, and **drops every other key silently** |

Optional, but if present must match the generic spec: `POST /v0.1/publish`,
`PUT`/`DELETE` of a version, the two status `PATCH` endpoints (bodies,
responses, 401/403/404/501 meanings). `/v0` aliases are optional for readers
and needed only to accept `mcp-publisher`.

### What we add (allowed by the specs)

- **Response-level `_meta` under our own reverse-DNS key** (OpenAPI
  `ServerResponse._meta` has `additionalProperties: true`): what our registry
  knows about a record — origin (mirrored from official vs published here),
  hosting status, validation result. Clients that do not know the key ignore
  it.
- **Extension endpoints under `/v0.1/x/<our namespace>/…`**: anything that is
  not a standard read, e.g. fetching the full countinghouse record of a
  version. Clients must tolerate their absence, so nothing standard may
  depend on them.
- **Our own publishing auth** (operator token): the generic spec leaves the
  mechanism to the registry.

### What that means for the countinghouse extension fields

A countinghouse server.json may be published to two places: our registry and
the official one. Whatever must survive the push to the official registry has
to fit `_meta["io.modelcontextprotocol.registry/publisher-provided"]` within
4096 bytes; everything else is dropped there without an error. A golden
`tools/list` carries every tool's description and input schema; beyond a
handful of tools it will not fit in 4 KB (not measured here; the spec should
measure it against countinghouse's existing goldens), so it cannot reliably
travel in server.json. That leads to a split
(proposed by the reviewer; to be settled in the spec):

- **In our registry**: the full countinghouse record (validated tool surface,
  permissions, pricing, composition targets) stored per server version and
  served from our registry (extension endpoint and/or response-level `_meta`).
- **In server.json, inside `publisher-provided`, under a namespaced subkey**:
  a small pointer — the record's content hash and its URL in our registry —
  well under 4 KB, so it survives both registries and lets any reader fetch
  and verify the full record.

Records mirrored from the official registry carry no countinghouse data
except what we compute ourselves (response-level `_meta`).

## Catalogue snapshot (measured 2026-11-10, official registry v1.8.9)

A dated snapshot, not a live fact. Method: one sequential crawl of
`GET /v0.1/servers?limit=100` (default filters, so **deleted versions
excluded**), following `nextCursor` to the end, 0.3 s pause between pages,
HTTP compression, curl's default User-Agent. It ran for about 44 minutes, so
it is not a consistent point-in-time copy; records published during the
crawl may be missing, which is what the incremental sync is for.

| Measure | Value |
|---|---|
| Pages of 100 for a full first sync | **2 394** (last page 29 records) |
| Records (server versions) | **239 329**, all unique by name + version |
| Server names | **61 471** (= records with `isLatest: true`) |
| Status | 232 863 `active`, 6 466 `deprecated` (deleted not requested) |
| Most versions for one name | 1 149 (`ai.bowmark/bowmark`); next 569, 419, 394 |
| Records with `remotes` | 131 692 |
| Package entries by type | npm 83 095, pypi 34 136, mcpb 16 855, oci 13 040, nuget 1 265, cargo 729 |
| Records with neither packages nor remotes | 1 959 |
| `$schema` versions in use | 2025-12-11: 226 789; 2025-09-29: 6 641; 2025-10-17: 3 520; 2025-07-09: 1 930; 2025-09-16: 399; 50 others (URL with a fragment, or not a static URL) |
| Records with a `server._meta` | 9 470; 8 671 of them with `publisher-provided` |
| `publisher-provided` size (compact JSON, ASCII-escaped) | median 343 bytes, p99 4 083, max 4 105 (non-ASCII escaping makes this count slightly larger than Go's) |
| Other keys in `server._meta` | none (consistent with the drop rule) |
| Keys in response-level `_meta` | only `io.modelcontextprotocol.registry/official` |
| Volume | ~256 MB of compact JSON, ~1 070 bytes per record on average |

What this means for the spec's mirroring section:

- A first full sync at the official page cap is ~2 400 requests; at a polite
  pace that is tens of minutes, so it should be resumable from the last applied
  cursor, and the `updated_since` checkpoint should be taken at the start of the
  first sync, not the end.
- Old schema versions are live in the catalogue (~12 500 records not on
  2025-12-11), so mirroring should store records as served, not re-validate them
  against the current schema.
- About 240 000 records of ~1 KB fit a single SQLite file comfortably
  (~¼ GB of JSON before indexes); the store needs indexes on (name, version),
  name substring and `updatedAt`.
