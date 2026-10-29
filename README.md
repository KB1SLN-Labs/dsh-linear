# @kb1slnlabs/dsh-linear

Linear issue-tracking tools for the DeepSeek Harness. A Cordis function/namespace
plugin (`export { name, inject, apply }`, no default export) that registers
model-facing tools through `ctx.tools.register`.

It exposes **two tool surfaces**:

1. **GraphQL tools (`linear_*`)** — 20 hand-written tools over the Linear GraphQL
   API (`https://api.linear.app/graphql`), authenticated with a personal API token.
2. **MCP parity tools (`linear_mcp_*`)** — a dynamic bridge to Linear's **hosted
   MCP server** (`https://mcp.linear.app/mcp`) over the official Streamable HTTP
   transport. These tool definitions are not written here: they are **discovered at
   runtime** with `tools/list`, so their number and shape are whatever Linear serves.

> Status: this package is **not published to npm**. Everything below installs from
> a local directory. Nothing in it has been verified against the live Linear GraphQL
> API or the live hosted MCP endpoint — see [Testing](#testing).

## Tools

### GraphQL tools (`linear_*`) — 20 registrations

| Tool | Purpose |
|---|---|
| `linear_issue_list` | List issues (filter by team key, state name, free-text search; `limit` default 20, max 50) |
| `linear_issue_get` | One issue by id or identifier (e.g. `APT-123`), incl. relations |
| `linear_issue_create` | Create an issue in a team |
| `linear_issue_update` | Update title, description, state, assignee, labels, priority |
| `linear_comment_add` | Add a comment to an issue |
| `linear_comment_list` | List comments on an issue (newest first) |
| `linear_relation_add` | Link a related issue (`related` / `blockedBy` / `blocks` / `parent` / `child`) |
| `linear_team_list` | List teams |
| `linear_team_get` | One team by id (UUID) or key |
| `linear_state_list` | List workflow states for a team |
| `linear_label_list` | List labels for a team |
| `linear_label_get` | One label by id (UUID) |
| `linear_label_create` | Create a label for a team |
| `linear_project_list` | List projects |
| `linear_project_get` | One project by id (UUID) |
| `linear_project_create` | Create a project (optional team keys) |
| `linear_cycle_list` | List cycles for a team |
| `linear_cycle_get` | One cycle by id (UUID) |
| `linear_user_list` | List users in the workspace |
| `linear_user_get` | One user by id (UUID) or email |

These are the "legacy" surface in the sense that they predate the MCP bridge and
are hand-modelled against Linear's GraphQL schema. They remain the default and are
the only tools that work with no MCP token configured.

### MCP parity tools (`linear_mcp_*`) — discovered, not declared

There is **no fixed list** of these tools in this repo. On connect the bridge pages
through `tools/list` and registers one harness tool per discovered MCP tool:

- public name = `linear_mcp_<rawName>` when it fits the function-name contract
  (≤64 chars, `[A-Za-z0-9_-]`); otherwise a lossy normalization plus a 12-hex
  SHA-256 hash of the identity, so distinct MCP tools never collapse onto one name.
  Names are a pure function of the discovered raw name, so they are stable across
  reconnects.
- calls are forwarded with `tools/call` using the **raw wire name**, never the public name.
- the discovered `inputSchema` is passed through unchanged; an advertised
  `outputSchema` is kept only if the harness supports that JSON Schema vocabulary,
  otherwise the output is unconstrained.
- `notifications/tools/list_changed` triggers re-discovery and an atomic generation
  swap (the full new list is fetched first; only then are the old registrations disposed).

## Configuration

Two independent credentials, resolved by the plugin at apply time:

| Setting | Env var | Plugin config | Used for | Header sent |
|---|---|---|---|---|
| GraphQL key | `LINEAR_API_KEY` | `apiKey` | `linear_*` tools | `Authorization: <raw key>` — **not** `Bearer` |
| MCP bearer token | `LINEAR_MCP_TOKEN` | `mcp.token` | `linear_mcp_*` bridge | `Authorization: Bearer <token>` |

The MCP token falls back in this order: `mcp.token` → `LINEAR_MCP_TOKEN` →
`apiKey` → `LINEAR_API_KEY`. So a single Linear API key can drive both surfaces.
The token is placed **only** in the `Authorization` header of requests to `mcp.url`;
it never appears in a tool name, description, schema, or log line (error text is
passed through a secret-redaction guard first).

```powershell
# PowerShell (current session)
$env:LINEAR_API_KEY    = "li_api_..."
$env:LINEAR_MCP_TOKEN  = "..."   # optional; falls back to LINEAR_API_KEY

# or persist for the user
setx LINEAR_API_KEY "li_api_..."
```

The `dsh` launcher inherits the parent environment, so any harness started after a
variable is set will see it.

### MCP bridge options (plugin config)

```yaml
# in a profile's cordis.patch.yml
- insert:
    - id: linear
      name: '@kb1slnlabs/dsh-linear'   # or a local path — see Install
      config:
        apiKey: li_api_...             # optional, falls back to LINEAR_API_KEY
        mcp:
          token: ''                    # optional; env fallbacks as above
          url: https://mcp.linear.app/mcp
          toolCallTimeoutMs: 60000     # per-call timeout
          reconnect:
            enabled: true
            initialDelayMs: 500        # bounded exponential backoff
            maxDelayMs: 30000
            maxAttempts: 10
```

The repo's own `cordis.patch.yml` inserts the plugin with **no config at all** — it
relies on the environment variables.

`LINEAR_MCP_DISABLED=1` turns the bridge off entirely. The bridge is **fail-soft**:
with no token, an unloadable MCP SDK, or a host context that lacks `ctx.effect`, the
GraphQL suite still registers and the bridge simply stays off (a warning is logged).
After `maxAttempts` consecutive failures the MCP tools are unregistered until the
plugin reloads or the host restarts.

Override env vars used to pin dependency resolution (mainly for offline tests):
`DSH_LINEAR_TOOLS`, `DSH_LINEAR_SCHEMA`, `DSH_LINEAR_MCP_SDK`,
`DSH_LINEAR_MCP_SDK_TRANSPORT`, `DSH_LINEAR_MCP_SDK_TYPES`, `DSH_LINEAR_MCP_SDK_ZOD`.

## Install

**This package is not on the npm registry — there is no published version to add by
name.** Install it locally, from this directory:

```powershell
# 1. install this plugin's own dependencies
npm install

# 2a. point a profile patch row at the local directory, e.g.
#     - insert:
#         - id: linear
#           name: 'D:/kb1slnlabs-projects/dsh-plugins/linear'

# 2b. or link it into the profile's / dsh install's node_modules
npm link    # then link node_modules/@kb1slnlabs/dsh-linear -> this directory
```

Peer dependencies `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis`, plus
`@modelcontextprotocol/sdk` and `zod`, normally resolve from the **dsh install's own**
`node_modules`. The plugin resolves each dependency as a bare specifier first, then
from an anchor derived portably from `process.execPath` (the npm/pnpm global prefix),
then `%APPDATA%/npm/node_modules` on Windows or `/usr/local/lib/node_modules` /
`/usr/lib/node_modules` on POSIX. The MCP SDK and its zod must come from one and the
same tree — a partial tree pins nothing.

## Testing

Two suites, both **offline** (loopback mock servers only; no Linear API call, no real
credential):

```
node test.js             # GraphQL half: module surface, 20 tool registrations,
                         # 40 GraphQL calls against a mock that mirrors the real
                         # Linear schema (flat UUID inputs, plural-field resolution,
                         # auth header), plus negative cases
node test-mcp-bridge.js  # MCP half: naming contract, paginated discovery, Bearer
                         # auth with no token leak, raw-name forwarding, isError
                         # handling, list_changed re-sync, disposal, fail-soft paths
```

`test.js` additionally carries a **live introspection guard** that runs only when
`LINEAR_API_KEY` is set: it introspects the real Linear schema and asserts every input
field and query field the plugin emits actually exists. Without a key it prints
`skip - introspection guard`. In an environment with no `LINEAR_API_KEY`, both suites
pass and that guard is skipped.

### What is verified vs. what is not

- **Verified (mock-tested):** everything the two suites above assert — registration,
  GraphQL query/mutation shape, the auth header forms, identifier resolution, error
  payloads, MCP discovery/naming/forwarding/reconnect/disposal lifecycle.
- **Not verified against live services:** no run in this repo's check has exercised a
  real `linear_*` call end-to-end against `api.linear.app`, and no run has connected
  to the real `https://mcp.linear.app/mcp` endpoint. The MCP tool set, its schemas,
  and its auth behaviour are therefore **unconfirmed against Linear's hosted server** —
  the bridge is only proven correct against a local mock that speaks MCP. Treat live
  use as untested until you run it with your own key and report what happens.

## Notes

- All GraphQL tools return JSON text; failures (a resolution error, an API error, a
  network error) come back as `{ "error": "…" }` rather than a thrown stack trace.
- Issue lookups accept either a UUID or a `TEAM-123` identifier.
- `linear_issue_update` with `assignee: ""` unassigns.
- The plugin registers no prompt sections and no client UI; it is purely a tool provider.

### How identifiers are resolved (resolve-then-mutate)

Linear's GraphQL inputs are **flat UUID fields** — `IssueCreateInput` has no nested
`team`/`state` objects, and the singular `Query.team` field accepts only a UUID `id`.
So before any write, the plugin resolves human identifiers to UUIDs through the
**plural** query fields, which *do* accept filters:

- a team key/name → `teams(filter: { key: { eq: … } })` → `teamId`
- a state name → `workflowStates(filter: { team: { id: { eq: <teamId> } }, name: { eq: … } })` → `stateId`

If a team key/name does not resolve to exactly one team, the tool fails with a clear
`Team '<x>' not found` error instead of sending a malformed mutation. An issue
identifier is resolved by splitting it into team key + number and querying
`issues(filter: { team: { key: { eq: … } }, number: { eq: … } })`, since `IssueFilter`
has no `identifier` field.
