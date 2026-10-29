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
> a local directory. The offline suites below are mock-tested, **except** `test-loader.mjs`
> and `test-image-runtime.mjs`, which run against the real host services — the plugin
> loader plus the real `ToolRuntime`/`SystemPrompt` — rather than stubs; the live checks
> this repo has run are the introspection guard in `test.js` and a real discovery of the
> hosted MCP tool set — see [Testing](#testing) for exactly what is and is not proven.

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

### What MCP result content becomes model-visible

The harness model vocabulary carries images as **durable attachment references**, not
inline bytes, so a `linear_mcp_*` result is projected before the model sees it:

- An `image` block is admitted **only when the current model route declares image
  input** — positive proof via the host's `llm.resolveModelInfo` for the exact
  provider/model that will read this result, plus a mounted `attachments` service. The
  bytes then go through the host's own admission pipeline (`attachments.saveImages`),
  which owns the count / aggregate-byte / media-type limits.
- Anything else — a model that does not declare image input, no mounted store, an
  unresolvable route, an invalid block (non-canonical base64, or a media type outside
  PNG/JPEG/WebP/GIF), or an admission rejection (`TOO_MANY_IMAGES`, `IMAGE_TOO_LARGE`,
  …) — yields a text diagnostic in place of that image:
  `[image unavailable: <media type>; <reason>; raw image data remains available to
  programmatic callers]`. One invalid block falls back every image in the same result.
- **The canonical raw result is never rewritten.** Base64 stays in `result.value` for
  programmatic callers either way; only the model-visible content carries references or
  diagnostics. Text and error behaviour are unchanged.
- `audio`, embedded `resource`, and `resource_link` blocks stay **text placeholders** —
  they are not admitted as attachments (`resource_link` becomes
  `Resource link: <name> (<uri>)`).

## Install

**This package is not on the npm registry — there is no published version to add by
name.** Until it is published, install it into a profile from this checkout:

```powershell
# 1. install this plugin's own dependencies
npm install

# 2. add it to a profile as a local link (prepublication example)
dsh plugin --profile web add link:<absolute-path-to-this-directory>
```

`link:` points pnpm at the directory rather than copying it, so the profile picks up
edits in place. Use an **absolute** path — that is what this repo's own install used,
and it is what makes the spec unambiguous regardless of where `dsh plugin` runs from.
The clean scratch profile behind the verification described under
[Testing](#testing) was installed through the **DSH plugin manager**, not by hand.
Adding the package also adds `@kb1slnlabs/dsh-linear` to the
profile's `dsh.profile.bundles` layer list, because its manifest declares
`dsh.bundle.patch`.

To add it as a plain dependency instead of a link, use `file:<absolute-path>` or a
packaged tarball (`npm pack`, then `dsh plugin --profile web add file:<path-to-tgz>`) —
that is how the scratch profile used by [Testing](#testing) was built.

Peer dependencies `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis`, plus
`@modelcontextprotocol/sdk` and `zod`, normally resolve from the **dsh install's own**
`node_modules`. The plugin resolves each dependency as a bare specifier first, then
from an anchor derived portably from `process.execPath` (the npm/pnpm global prefix),
then `%APPDATA%/npm/node_modules` on Windows or `/usr/local/lib/node_modules` /
`/usr/lib/node_modules` on POSIX. The MCP SDK and its zod must come from one and the
same tree — a partial tree pins nothing.

The `@deepseek-ai/dsh-tools` this package pins (`0.1.5-rc.2`) was verified against host
**0.2.1-rc.3**. In a base-only scratch profile it can log **missing-peer warnings** —
that is expected: the host supplies those services, and the pinned copy exists so the
plugin resolves its own peer at all. Do not read such a warning as a failure.

## Testing

Four suites: the mock halves are **offline** (loopback mock servers only; no real
credential), but `test.js` additionally runs a live schema check against
`api.linear.app` whenever `LINEAR_API_KEY` is set — see below, and note that
`test-loader.mjs` and `test-image-runtime.mjs` are not mocks at all.

```
node test.js                # GraphQL half: module surface, 20 tool registrations,
                            # 40 GraphQL calls against a mock that mirrors the real
                            # Linear schema (flat UUID inputs, plural-field resolution,
                            # auth header), plus negative cases; and, when
                            # LINEAR_API_KEY is set, the live introspection guard
node test-mcp-bridge.js     # MCP half: naming contract, paginated discovery, Bearer
                            # auth with no token leak, raw-name forwarding, isError
                            # handling, list_changed re-sync, disposal, fail-soft paths,
                            # and image-result projection/admission through the bridge
node test-loader.mjs        # loader half — needs two environment variables, see below
node test-image-runtime.mjs # image half: real ToolRuntime + SystemPrompt, a stubbed
                            # llm route that declares image input and a stubbed
                            # attachment store; asserts an MCP image result comes back
                            # as a model-visible image block while the raw base64 stays
                            # in result.value. No network, no profile, no env vars.
```

### `test-loader.mjs` — what it runs and what it needs

Unlike the mock suites, `test-loader.mjs` exercises the **real plugin loader and the real
host tool runtime**: it boots a Cordis `Context`, attaches the host's real
`SystemPrompt` and `ToolRuntime` services (imported from the dsh installation, not
stubbed), runs `cordis-plugin-loader`, installs this plugin into that context through
the profile, asserts the entry got a live fiber and that exactly the 20 `linear_*`
names are known to the runtime — then disposes the fiber and asserts all 20 are gone.
It carries a 15-second step deadline: before each phase it checks whether 15 seconds
have elapsed and, if so, fails with `15 second bound exceeded at: <label>`. That
deadline is a progress budget between steps, **not** a hard timeout — it cannot
interrupt an asynchronous call that never settles, so a hung import or await stalls the
run instead of being cut off at 15 seconds.

Both variables are **required**; a missing or malformed one fails immediately with an
actionable message rather than an import error:

| Variable | Meaning | Accepted form |
|---|---|---|
| `DSH_ROOT` | the dsh installation directory — the one holding `node_modules/@deepseek-ai/cordis`, from which `cordis`, `cordis-plugin-loader`, `dsh-system-prompt` and `dsh-tools` are resolved | absolute filesystem path (a trailing slash is added for you) |
| `LINEAR_TEST_PROFILE` | the profile directory to load the plugin against — it must already have this package installed as a dependency/bundle layer | absolute filesystem path **or** a `file:` URL; converted with `pathToFileURL` plus a trailing slash so it is a directory URL, and checked for existence |

A non-`file:` URL (`http:`, `npm:`, …) is rejected. Relative paths are not accepted —
there is no sensible anchor for them here.

```powershell
$env:DSH_ROOT = "C:/Users/<you>/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh"
$env:LINEAR_TEST_PROFILE = "<dsh-home>/profiles/<profile>"   # or file:///<same path>
node test-loader.mjs
```

The suite deletes `LINEAR_API_KEY`, `LINEAR_MCP_TOKEN`, `LINEAR_APIKEY` and
`LINEAR_KEY` from its own environment before loading, so the plugin it installs cannot
pick up a live credential and the bridge stays off. That clearing is scoped to this
process — other suites behave differently: `test.js` deliberately runs live against
`api.linear.app` when a real key is present (see below).

**What this does not cover:** it is not a full headless boot. No LLM, session log,
filesystem sandbox, or app entry tree is started — only the loader plus those two host
services inside a bare `Context`. And it never contacts Linear: no GraphQL call and no
connection to the hosted MCP server are made, so the discovered `linear_mcp_*` surface
is not exercised here. The scratch profile it runs against is a throwaway directory,
not your day-to-day profile.

`test.js` additionally carries a **live introspection guard** that runs only when
`LINEAR_API_KEY` is set: it introspects the real Linear schema and asserts every input
field and query field the plugin emits actually exists. Without a key it prints
`skip - introspection guard`. So in an environment with no `LINEAR_API_KEY` the suite
passes with that guard skipped, but **with a key set, `test.js` does use live network** —
it sends a real introspection request to `https://api.linear.app/graphql`, and a schema
mismatch makes the run throw rather than skip.

### `test-image-runtime.mjs` — what it runs and what it needs

No environment variables and no profile: it builds a bare Cordis `Context`, attaches the
real `SystemPrompt` and `ToolRuntime` (mode `native`), registers one hand-built MCP
definition, executes it through `tools.execute`, and asserts the finalized content is
`[text, image-with-attachment-ref]` while `result.value` still carries the raw base64.
The `llm` route (`inputModalities: ['image']`) and the attachment store are stubs — so
this proves the bridge's admission **decision** and projection against the real runtime,
not a real model's image support or the host's real byte/count limits. It needs the same
peer resolution as the plugin itself (a dsh installation to import `cordis`,
`dsh-tools`, and `dsh-system-prompt` from), and it can emit the missing-peer warnings
described under [Install](#install).

### What is verified vs. what is not

- **Verified (mock-tested):** what `test.js` and `test-mcp-bridge.js` assert —
  registration, GraphQL query/mutation shape, the auth header forms, identifier
  resolution, error payloads, MCP discovery/naming/forwarding/reconnect/disposal
  lifecycle, and image admission refusals against stubbed host services.
- **Verified against real host services (not mocks):** `test-loader.mjs` loads this
  package through the real plugin loader into a real `ToolRuntime`, and
  `test-image-runtime.mjs` finalizes an MCP image result through the real
  `ToolRuntime`/`SystemPrompt`. The scratch profile behind that run was installed via
  the **DSH plugin manager** and verified on **desktop runtime 0.2.1-rc.3** with the
  Cordis loader plus `ToolRuntime` — a bare host context, **not** a full desktop app
  boot: no LLM turn, session log, sandbox, or app entry tree was started.
- **Verified against live services:** the hosted MCP bridge has been checked against
  the real `https://mcp.linear.app/mcp` endpoint — a real run through the DSH
  `ToolRuntime`, installing this package from a clean scratch package, discovered
  **68** `linear_mcp_*` tools. The live Linear GraphQL introspection guard in `test.js`
  has likewise run with a real key and passed. So the MCP tool count, names, and schemas
  are what Linear actually served at that time, not guesses.
- **Not verified:** no run in this repo's check has exercised a real `linear_*` **write**
  end-to-end against `api.linear.app` — the GraphQL half is proven against a mock that
  mirrors the introspected schema (plus the live schema-shape guard above), not against
  real issue mutations. Image admission likewise has **not** been exercised with a real
  model route or a real attachment store — only with declared-modalities and stored-ref
  stand-ins. Nothing here was run on more than that one Windows host/runtime, so treat
  other platforms as untested. Linear's hosted MCP tool set can also change server-side,
  so re-discover it with your own key before relying on the exact count or shapes above.

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
