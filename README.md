# @kb1slnlabs/dsh-linear

Linear issue-tracking tools for the DeepSeek Harness. A Cordis function/namespace
plugin (`export { name, inject, apply }`, no default export) that registers
model-facing tools through `ctx.tools.register`.

It exposes **one tool surface**: 26 hand-written tools over the **Linear GraphQL
API** (`https://api.linear.app/graphql`), authenticated with a personal API token.

**There is no MCP in this package — at all.** It does not host an MCP server, it
does not act as an MCP client, it never connects to `mcp.linear.app`, and it has
no MCP configuration, dependency, or test. The 26 `linear_*` tools below are the
entire surface; nothing else is registered under any condition.

> **Scope honesty:** 25 of these tools are a fixed, hand-modelled subset of what
> the Linear GraphQL API can do. They cover issues, comments, relations, teams,
> states, labels, projects, cycles and users — and nothing beyond that (no
> attachments, no documents/projects search, no webhooks, no auth/user-management
> administration, no bulk operations). The set is not auto-discovered and does not
> grow on its own: if you need a capability outside the table below, it is not
> there. The 26th tool, [`linear_graphql`](#direct-graphql-escape-hatch-linear_graphql),
> is the deliberate escape hatch for exactly that case — but what it can reach is
> bounded by Linear's own API and by your key's permissions, so it extends
> coverage, it does not guarantee parity. See [Limitations](#limitations).

> Status: this is **version 0.2.2** of the standalone implementation — the
> GitHub release for it is
> [KB1SLN-Labs/dsh-linear/releases/tag/v0.2.2](https://github.com/KB1SLN-Labs/dsh-linear/releases/tag/v0.2.2),
> and the package is published on npm as `@kb1slnlabs/dsh-linear`. The earlier
> **0.1.0** release, also on the public GitHub repository `KB1SLN-Labs/dsh-linear`
> and on npm, shipped with an MCP bridge to Linear's hosted MCP server; that
> bridge is gone from 0.2.x (see **There is no MCP in this package — at all.**
> above and [Limitations](#limitations)), so do not treat 0.1.0 as this package.
> The offline suite described under
> [Testing](#testing) is mock-tested (loopback only), except
> that it runs a live schema check when `LINEAR_API_KEY` is set;
> `test-loader.mjs` is a separate loader smoke test, not part of `npm test`.

## Tools

### GraphQL tools (`linear_*`) — 26 registrations

| Tool | Purpose |
|---|---|
| `linear_issue_list` | List issues (filter by team key, state name, free-text search; `limit` default 20, max 50; cursor pagination via `after` / `pageInfo`) |
| `linear_issue_get` | One issue by id or identifier (e.g. `APT-123`), incl. relations |
| `linear_issue_create` | Create an issue in a team |
| `linear_issue_update` | Update title, description, state, assignee, labels, priority |
| `linear_issue_archive` | Archive an issue by id or identifier |
| `linear_issue_unarchive` | Unarchive a previously archived issue by id or identifier |
| `linear_comment_add` | Add a comment to an issue |
| `linear_comment_update` | Update a comment body (comment UUID from `linear_comment_list`) |
| `linear_comment_delete` | Delete a comment (comment UUID) — destructive |
| `linear_comment_list` | List comments on an issue (newest first; cursor pagination via `after` / `pageInfo`) |
| `linear_relation_add` | Link a related issue (`related` / `blockedBy` / `blocks` / `parent` / `child`) |
| `linear_team_list` | List teams (`after` / `pageInfo`; page size fixed at 100, no `limit` argument) |
| `linear_team_get` | One team by id (UUID) or key |
| `linear_state_list` | List workflow states for a team (cursor pagination via `after` / `pageInfo`) |
| `linear_label_list` | List labels for a team (cursor pagination via `after` / `pageInfo`) |
| `linear_label_get` | One label by id (UUID) |
| `linear_label_create` | Create a label for a team |
| `linear_project_list` | List projects (`limit` default 20, max 50; cursor pagination via `after` / `pageInfo`) |
| `linear_project_get` | One project by id (UUID) |
| `linear_project_create` | Create a project (optional team keys) |
| `linear_project_update` | Update a project: name, description, content, icon, color, team keys, start/target date, priority |
| `linear_cycle_list` | List cycles for a team (`limit` default 20, max 50; cursor pagination via `after` / `pageInfo`) |
| `linear_cycle_get` | One cycle by id (UUID) |
| `linear_user_list` | List users in the workspace (`limit` default 20, max 50; cursor pagination via `after` / `pageInfo`) |
| `linear_user_get` | One user by id (UUID) or email |
| `linear_graphql` | **Escape hatch** — send an arbitrary GraphQL document (query *or* mutation) straight to the Linear API; see below |

Cursor pagination is live on **all eight** list tools — `linear_issue_list`,
`linear_comment_list`, `linear_team_list`, `linear_state_list`,
`linear_label_list`, `linear_project_list`, `linear_cycle_list` and
`linear_user_list`. Each accepts an optional `after` cursor (the previous page's
`pageInfo.endCursor`) and returns `pageInfo { hasNextPage, endCursor }`; the
cursor is always sent as a GraphQL variable (`$after: String`), never
interpolated into the document, and a server that reports no `pageInfo` yields
`pageInfo: null` rather than an invented value. Page sizes are unchanged: `limit`
defaults to 20 and is clamped to a maximum of **50** wherever it exists
(`issue_list`, `comment_list`, `project_list`, `cycle_list`, `user_list`), and
`linear_team_list` has no `limit` argument at all — its page size stays fixed at
100. `state_list` and `label_list` likewise take no `limit`; they are paginated
purely through `after`. See [Limitations](#limitations).

### Direct GraphQL escape hatch (`linear_graphql`)

One tool is not a hand-modelled endpoint. `linear_graphql` takes the caller's own
GraphQL document and forwards it verbatim to the **same** fixed endpoint
(`https://api.linear.app/graphql`) with the **same** configured key, through the
same client and the same `{ "error": … }` wrapper every other tool uses. It adds
no endpoint, no dependency, no setting, and no credential of its own.

| Argument | Type | Notes |
|---|---|---|
| `query` | string, **required** | The GraphQL document — a query or a mutation. Must be non-blank. Sent verbatim; the tool adds, wraps, or normalises nothing. |
| `variables` | object, optional | GraphQL variable values keyed by name (e.g. `{ "id": "<uuid>" }`). Prefer variables over splicing values into the document text. |

The result is the server's raw `data`, JSON-stringified as `{ "data": … }`: no
projection, no field curation, no `pageInfo` normalisation — the document you
write decides the shape, including whether you ask for `pageInfo { hasNextPage
endCursor }` yourself.

Both queries and mutations are allowed, and that is the point. A mutation
through this tool really writes, and what it may read or change is governed
entirely by the permissions attached to your Linear API key — the same authority
every other tool here already runs under. There is no extra allow-list, no
read-only mode, and no dry-run: if your key can do it and the Linear schema
accepts the document, it happens.

**Coverage here depends on Linear's API, not on this package.** The escape hatch
can only reach what `api.linear.app` currently exposes to your key — fields,
types, and mutations Linear defines today, subject to their own deprecations,
rate limits, and workspace scoping. It is *not* named-tool parity: there are no
guarantees that a capability exists, that it stays stable across Linear releases,
that the plugin's live schema guard covers it, or that the offline mock suite
models it (the suite proves the plumbing — document pass-through, variables as
variables, and error handling — not any specific user-written document). The 25
named tools carry curated inputs, identifier resolution, and projected outputs;
this one deliberately carries none of that.

## Configuration

One credential — **your own Linear personal API key** (create it in Linear's
settings; keep it private, never paste it into a conversation, screenshot, issue,
commit, or log). The plugin resolves it at apply time from three sources. The
precedence is fixed and never widened — first non-empty source wins:

| Order | Source | Notes |
|---|---|---|
| 1 | `apiKey` in the plugin config (patch row) | used only when it is **non-empty**; the schema's `.default('')` means an absent field resolves to `""`, which falls through |
| 2 | `LINEAR_API_KEY` environment variable | as seen by the plugin process at call time |
| 3 | the key file `~/.config/linear/api-key` | exactly `join(homedir(), '.config', 'linear', 'api-key')`; read with `fs` only (no subprocess, no network), value sent trimmed; a missing, unreadable, or blank file counts as "no key" |

If none of the three yields a key, every tool returns
`{ "error": "Linear API key not configured: …" }` — the message names all three
sources — instead of throwing. There is no fourth source, no override env var for
the key-file path, and nothing that changes or widens this order.

| Setting | Env var | Plugin config | Used for | Header sent |
|---|---|---|---|---|
| GraphQL key | `LINEAR_API_KEY` | `apiKey` | all 26 `linear_*` tools, incl. `linear_graphql` | `Authorization: <raw key>` — **not** `Bearer` |

```powershell
# PowerShell (current session) — replace the placeholder, do not use a real key here
$env:LINEAR_API_KEY = "li_api_..."

# or persist for the user
setx LINEAR_API_KEY "li_api_..."
```

Or skip the environment entirely and put the key in one of the other two sources.
The key file has no format beyond the key itself — write it as **the only content
of the file**, nothing else:

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\linear" | Out-Null
# paste your own key in place of the placeholder, then save the file
Set-Content -NoNewline -Path "$HOME\.config\linear\api-key" -Value "li_api_..."
```

Any one of the three is enough; you do not need to configure all of them. If you
set more than one, the table above decides which is used — an `apiKey` config value
shadows both `LINEAR_API_KEY` and the key file, and a non-empty `LINEAR_API_KEY`
shadows the key file.

The `dsh` launcher inherits the environment of **its own parent process**. Setting a
user variable with `setx` does not push it into processes that are already running,
and it is not guaranteed to reach every launcher: anything started from an existing
parent (an already-running Desktop/app session, a service, a scheduled or terminal
session opened before the change) keeps the environment that parent had. In practice
this means **a Desktop instance that was already running when you set
`LINEAR_API_KEY` will not see it** — fully quit Desktop (tray process included) and
start it again from a shell that has the variable, or start Desktop fresh from the
taskbar after signing out and back in. To be sure a given harness sees
`LINEAR_API_KEY`, start it from a shell that has the variable —
or skip the environment entirely and put the key in the config `apiKey` or the
key-file path above, which do not depend on inherited environment at all.

That is the whole config object:

```ts
const Config = z.object({ apiKey: z.string().default('') })
```

There are no other settings and no other environment variables. The plugin reads
no MCP-related setting, opens no non-GraphQL connection, and an `mcp` block left in
an old profile's config is simply ignored (the schema declares no such field).

The repo's own `cordis.patch.yml` inserts the plugin with **no config at all** — it
relies on `LINEAR_API_KEY` or the `~/.config/linear/api-key` file.

Override env vars used to pin dependency resolution (mainly for offline tests):
`DSH_LINEAR_TOOLS`, `DSH_LINEAR_SCHEMA`.

## Install

### Windows quick start (DSH Desktop)

If you use **DSH Desktop**, follow this first. **Desktop and web are separate
profiles**: installing the plugin into one does not make it available in the
other. The commands further down this section target the **web profile**.

1. **Quit DSH Desktop completely**, including its tray process — closing the
   window is not enough. Check the system tray, and confirm no harness process is
   left:

   ```powershell
   Get-Process | Where-Object { $_.ProcessName -like "*DeepSeek*" }
   ```

2. **Install the plugin into the Desktop profile** with the DSH CLI bundled inside
   the Desktop installation (verified path — this is the one to use for Desktop;
   do not rely on a `dsh` on your PATH, which may belong to a different install):

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @kb1slnlabs/dsh-linear@0.2.2
   ```

3. **Reopen DSH Desktop and start a new conversation.** A session that was already
   open will not pick up the newly installed plugin.

4. **Give the plugin a Linear API key** — see
   [Configuration](#configuration) below for the three sources, their precedence,
   and why an environment variable you just set may not reach Desktop. Use your own
   personal Linear API key; never paste a real key into a chat, screenshot, issue,
   or log, and do not share one with anyone.

5. **Check that it works**, read-only, from the new conversation:

   ```
   Use linear_issue_get to read <issue-id> and report its title and status
   ```

   Replace `<issue-id>` with an issue you can see, e.g. `TEAM-123`. A correct answer
   means the plugin loaded **and** the key resolved.

0.2.2 needs a **full DSH host that satisfies the peer range below** — it will not
load into a bare base-only profile (see
[Dependencies provided by the host](#dependencies-provided-by-the-host)). The
Desktop runtime it has actually been tested against is **0.2.1-rc.3**; other
platforms and runtimes are untested, and no real write to Linear has been
verified end-to-end (see
[What is verified vs. what is not](#what-is-verified-vs-what-is-not)).

**If something goes wrong:**

- **No `linear_*` tools appear** → you most likely installed into the other
  profile: Desktop and web are separate. Re-run step 2 with `--profile desktop`,
  then start a **new** conversation — an existing one keeps the old tool list.
- **`Linear API key not configured`** → none of the three sources in the
  [Configuration](#configuration) table is yielding a key; check all three, and
  remember that a variable set after Desktop started may never reach it.
- **PTC prepare error — `Cannot read properties of undefined (reading 'prepare')`
  — on 0.2.1** → install the 0.2.2 package as above (it removes the duplicate
  `@deepseek-ai/dsh-tools` copy that causes this) and restart Desktop.

### The four install routes below are web-profile alternatives

This is **version 0.2.2** of the standalone implementation; its release is
[KB1SLN-Labs/dsh-linear/releases/tag/v0.2.2](https://github.com/KB1SLN-Labs/dsh-linear/releases/tag/v0.2.2),
and the tarball attached to that release — `kb1slnlabs-dsh-linear.tgz` — is the
pinned artifact for route 4 below. Four install routes:

```powershell
# 0. install this plugin's own dependencies (local checkout route only)
npm install

# 1. local link with an absolute path (working checkout, edits picked up in place)
dsh plugin --profile web add link:<absolute-path-to-this-directory>

# 2. from the public GitHub repository (default branch — unpinned)
dsh plugin --profile web add github:KB1SLN-Labs/dsh-linear

# 3. from npm, by package name (latest published version)
dsh plugin --profile web add @kb1slnlabs/dsh-linear

# 4. version-pinned release asset — download the tarball attached to the v0.2.2
#    GitHub release, then install it from disk:
#    https://github.com/KB1SLN-Labs/dsh-linear/releases/download/v0.2.2/kb1slnlabs-dsh-linear.tgz
dsh plugin --profile web add file:./kb1slnlabs-dsh-linear.tgz
```

All four write to the **web** profile (`--profile web`). For DSH Desktop use the
bundled CLI and `--profile desktop` from the quick start above. If you want one of
these exact routes for Desktop, swap `--profile web` for `--profile desktop` and
invoke the bundled `dsh.cmd` instead of a bare `dsh`.

Route 1 (`link:`) points pnpm at the directory rather than copying it, so the profile
picks up edits in place. Use an **absolute** path — that is what this repo's own install
used, and it is what makes the spec unambiguous regardless of where `dsh plugin` runs
from. Routes 2–4 install a copy instead, so later source edits do not leak into the
profile. Only route 4 pins an exact version: `kb1slnlabs-dsh-linear.tgz` is the fixed
release-asset name for the v0.2.2 GitHub release — renamed from the output of
`npm pack`, not the filename npm itself generates. Route 2 follows the repository's
default branch and route 3 follows npm's `latest`, so neither is guaranteed to install
0.2.2 once newer work or releases exist; use route 4 when reproducibility matters.

The clean scratch profile behind the verification described under
[Testing](#testing) was installed through the **DSH plugin manager**, not by hand.
Adding the package also adds `@kb1slnlabs/dsh-linear` to the
profile's `dsh.profile.bundles` layer list, because its manifest declares
`dsh.bundle.patch`.

To add it as a plain dependency instead of a link, use `file:<absolute-path>` or a
packaged tarball (`npm pack`, then `dsh plugin --profile web add file:<path-to-tgz>`) —
that is how the scratch profile used by [Testing](#testing) was built.

### Dependencies provided by the host

Peer dependencies `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis`, plus the
`@deepseek-ai/schemastery` this package depends on, normally resolve from the **dsh
install's own** `node_modules`. The plugin resolves each dependency as a bare specifier
first, then from an anchor derived portably from `process.execPath` (the npm/pnpm global
prefix), then `%APPDATA%/npm/node_modules` on Windows or `/usr/local/lib/node_modules` /
`/usr/lib/node_modules` on POSIX.

The `@deepseek-ai/dsh-tools` this package needs is **provided by the host DSH runtime**, not shipped with it. It is a `peerDependency` at `^0.2.1-rc.3`, marked
**optional** in `peerDependenciesMeta` so package managers do not auto-install or
hoist their own copy into the profile, and it appears only in `devDependencies`
(`0.2.1-rc.3`) for local test use — the lockfile entries are `dev`-only, so an
installed profile gets no `@deepseek-ai/dsh-tools` of its own.

Why: DSH's PTC scheduler keeps its state on a **private per-module Symbol**. A copy
of `@deepseek-ai/dsh-tools` installed at the profile root is a second instance of
that package, and a tool compiled by one instance and executed by the other trips
`Cannot read properties of undefined (reading 'prepare')`. That extra copy is what
this packaging change removes. To bind `defineTool` to the host wherever possible,
`index.js` resolves `@deepseek-ai/dsh-tools` **first** from the running DSH process
entry point (`process.argv[1]`, accepted only when it is an absolute path that
exists), and only then through the fallbacks above. No machine paths are hardcoded.
`@deepseek-ai/schemastery` keeps its original resolution chain — it carries no such
per-module state.

> **Status of this explanation:** the mechanism is **demonstrated** — two copies of
> `@deepseek-ai/dsh-tools` really are two instances, and a tool compiled by one and
> executed by the other really does trip
> `Cannot read properties of undefined (reading 'prepare')`, because the PTC
> scheduler's state lives on a private per-module Symbol. That makes it the **likely
> explanation** for the live failure, but it has **not** been proven to be the actual
> cause in the session where the error was seen — see
[What is verified vs. what is not](#what-is-verified-vs-what-is-not).

A **bare base-only profile can still fail to load** the plugin: `@deepseek-ai/dsh-tools`
needs host peers such as `@deepseek-ai/dsh-sandbox`, which a base-only profile does
not provide — this is a load failure, not a warning you can ignore. Use a **full web
or Desktop profile** instead.

The `@deepseek-ai/dsh-tools` peer requirement in `package.json` is
`^0.2.1-rc.3`, which names the host this plugin has actually been verified against —
**DSH Desktop 0.2.1-rc.3**, the loader run described under [Testing](#testing).
Earlier manifests declared `^0.1.1-rc.2`, and for a while an OR range
(`^0.1.1-rc.2 || ^0.2.1-rc.3`); both are gone in 0.2.1, because the 0.1 series is
not a host this release targets. `test.js` now **does** check this packaging — the
peer range, its optional marker, the absence of a production dependency on
dsh-tools, dev-only lockfile entries, and the resolution order described above (see
[Testing](#testing)) — so keep the manifest and the lockfile consistent.

## Testing

```
node test.js          # module surface (name/inject/apply/Config), 26 tool
                      # registrations, dsh-tools packaging and resolution (no
                      # production dependency on it, peer ^0.2.1-rc.3 marked
                      # optional, dev-only lockfile entries, resolution prefers
                      # the DSH process entry point, schemastery untouched), an
                      # `mcp` config proven inert (no extra
                      # tools, no log lines, no effects, no connection), ~183
                      # GraphQL calls against a loopback mock that mirrors the
                      # real Linear schema (flat UUID inputs, plural-field
                      # resolution, raw-key auth header) — the exact call count
                      # is printed by the suite rather than asserted — cursor
                      # pagination across all eight direct list tools
                      # (issue, comment, team, state, label, project, cycle,
                      # user), the five direct
                      # write tools (project update, comment update/delete, issue
                      # archive/unarchive) incl. unresolved identifiers and
                      # success:false payloads, the linear_graphql escape hatch
                      # (query and mutation documents, variables as variables,
                      # invalid arguments, GraphQL and HTTP errors), negative
                      # cases; and, when LINEAR_API_KEY is set, the live
                      # introspection guard
```

`npm test` runs exactly that. It needs no key and makes no network call **except**
the introspection guard below, which runs only when `LINEAR_API_KEY` is present.

`test.js` additionally carries a **live introspection guard** that runs only when
`LINEAR_API_KEY` is set: it introspects the real Linear schema and asserts every input
field, query field, mutation field, mutation argument, and payload field the plugin emits
actually exists. Without a key it prints
`skip - introspection guard`. So in an environment with no `LINEAR_API_KEY` the suite
passes with that guard skipped, but **with a key set, `test.js` does use live network** —
it sends a real introspection request to `https://api.linear.app/graphql`, and a schema
mismatch makes the run throw rather than skip.

### `test-loader.mjs` — optional loader smoke test (not part of `npm test`)

Exercises the **real plugin loader and the real host tool runtime**: it boots a Cordis
`Context`, attaches the host's real `SystemPrompt` and `ToolRuntime` services (imported
from the dsh installation, not stubbed), runs `cordis-plugin-loader`, installs this
plugin into that context through the profile, asserts the entry got a live fiber and
that exactly the 26 `linear_*` names are known to the runtime — then disposes the fiber
and asserts all 26 are gone. It carries a 15-second step deadline: before each phase it
checks whether 15 seconds have elapsed and, if so, fails with
`15 second bound exceeded at: <label>`. That deadline is a progress budget between steps,
**not** a hard timeout — it cannot interrupt an asynchronous call that never settles.

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
pick up a live credential. (It clears the MCP variable for cleanliness only — this
plugin no longer reads it.) That clearing is scoped to this process; `test.js` behaves
differently, deliberately running live against `api.linear.app` when a real key is
present (see above).

**What this does not cover:** it is not a full headless boot. No LLM, session log,
filesystem sandbox, or app entry tree is started — only the loader plus those two host
services inside a bare `Context`. And it never contacts Linear: no GraphQL call is made.
The scratch profile it runs against is a throwaway directory, not your day-to-day
profile.

### What is verified vs. what is not

- **Verified (mock-tested):** what `test.js` asserts — registration of exactly the 26
  tools, GraphQL query/mutation shape, the raw-key auth header form, identifier
  resolution, `{ error }` payloads, cursor pagination on all eight direct list
  tools (first-page `pageInfo`, `after` passed only as a `$after` variable, blank
  and non-string cursors treated as no cursor, a bad cursor surfacing as a clean
  error, and a pageInfo-less server normalising to `null`), page sizes unchanged
  (`limit` default 20 clamped to max 50; `team_list` still `first: 100` with no
  `limit` parameter),
  the five direct write tools (`projectUpdate`, `commentUpdate`, `commentDelete`,
  `issueArchive`, `issueUnarchive`) — including that an unresolved project name or issue
  identifier never reaches a mutation and that a `success: false` payload surfaces as a
  clean error — the `linear_graphql` escape hatch (a query document and a mutation
  document forwarded verbatim, caller variables arriving as variables rather than query
  text, blank/non-string/missing `query` and non-object `variables` rejected before any
  request, GraphQL `errors[]` and non-2xx responses surfacing through the same
  `{ error }` wrapper; all against loopback, so no real write happens) — and that an
  `mcp` config block is inert (registers nothing, logs nothing, calls no effect).
- **Verified against real host services (not mocks):** `test-loader.mjs` loads this
  package through the real plugin loader into a real `ToolRuntime`. The scratch profile
  behind that run was installed via the **DSH plugin manager** and verified on **desktop
  runtime 0.2.1-rc.3** with the Cordis loader plus `ToolRuntime` — a bare host context,
  **not** a full desktop app boot: no LLM turn, session log, sandbox, or app entry tree
  was started.
- **Verified (CLI install smoke, against the earlier 0.2.1 tarball):** the **0.2.1 final
  tarball** (`kb1slnlabs-dsh-linear.tgz`, route 4) was installed into a clean scratch
  profile based on the **shipped web template**, and the real Cordis loader test
  (`test-loader.mjs`) run against that profile registered **26 tools** on **DSH runtime
  0.2.1-rc.3**. That is an install-and-load check only: no model turn and no full desktop
  GUI boot were performed. It predates the 0.2.2 candidate, so it says nothing about that
  packaging — the only 0.2.2-candidate session evidence is the user report below, not this
  line.
- **Verified against live services:** the Linear GraphQL introspection guard in `test.js`
  has run with a real key and passed — the schema fields this plugin emits, including the
  five direct-write mutations, their arguments, and their payload shapes (`ProjectPayload`,
  `CommentPayload`, `DeletePayload`, `IssueArchivePayload`), exist.
- **Reported by the user (not an automated test):** in a **new conversation on DSH
  Desktop 0.2.1-rc.3** using the **local 0.2.2 candidate**, a **read-only `APT-941`
  lookup succeeded**. That is a human report about one session, deliberately kept apart
  from the automated suites above: it was not run by `test.js`, `test-loader.mjs`, or any
  script in this repo, and **no live mutations were tested** — nothing wrote to Linear. It
  shows the plugin loaded and answered a read through the real desktop runtime; it does
  not prove the packaging explanation below was the cause of the earlier failure.
- **Not verified:** no run in this repo's check has exercised a real `linear_*` **write**
  end-to-end against `api.linear.app` — the GraphQL half is proven against a mock that
  mirrors the introspected schema (plus the live schema-shape guard above), not against
  real issue mutations. Nothing here was run on more than one Windows host/runtime, so
  treat other platforms as untested.
- **Reproduced mechanism, likely but unproven cause:** the `@deepseek-ai/dsh-tools`
  double-instance explanation in
  [Dependencies provided by the host](#dependencies-provided-by-the-host) — that a
  profile-root copy shadowed the desktop runtime and produced
  `Cannot read properties of undefined (reading 'prepare')` — is **reproduced as a
  mechanism** (a tool compiled by one copy and executed by another really does trip that
  error, because the scheduler's state is a private per-module Symbol) and is the
  **likely explanation** for what was seen live. What has *not* been established is that a
  second copy was in fact the loaded one in that failing session: no evidence captured from
  the failure itself identifies which copy was in play, so it stays the leading explanation
  rather than a proven root cause. The packaging contract itself *is* checked by `test.js`:
  no production dependency on dsh-tools, an optional
  `^0.2.1-rc.3` peer, dev-only lockfile entries, and resolution that prefers the running
  DSH process entry point. The only 0.2.2-candidate session evidence available is the
  user-reported successful read-only lookup above; no automated live run against 0.2.2 has
  been performed here, and no mutation path has been exercised live.

## Limitations

Stated plainly, because 25 of the tools above are a fixed hand-modelled subset:

- **Pagination covers the list tools but not the page sizes.** All eight list
  tools paginate (`after` + `pageInfo`), so nothing is cut off *silently* — you can
  always continue from `pageInfo.endCursor`. What stays capped is the page size:
  `limit` defaults to 20 and never exceeds **50** (`issue_list`, `comment_list`,
  `project_list`, `cycle_list`, `user_list`), while `team_list` sends a fixed
  `first: 100` and takes no `limit`, and `state_list`/`label_list` take no `limit`
  at all. A single call therefore returns only one capped page; reading everything
  means following the cursor yourself. The `_get` tools are not paginated — they
  fetch one entity.
- **No search beyond free-text on issues.** `linear_issue_list`'s `search` matches
  title/description case-insensitively; there is no project, document, or cycle search.
- **Create/update coverage is narrow but no longer empty.** Issues, comments, relations,
  labels and projects can be created; issues and projects can be updated, comments edited
  and deleted, and issues archived/unarchived. Nothing else can: there is no team or state
  management, no cycle create, no project delete, no bulk operation, no attachment upload,
  and no user administration. Among the named tools, `linear_comment_delete` is the
  only destructive one and has no undo — but it is not the only destructive thing
  this package can do: `linear_graphql` runs any mutation your key permits, so
  operations outside the named set (deletions included) are reachable through it.
- **`linear_comment_add` targets issues only** — it sends `CommentCreateInput.issueId`,
  so it cannot comment on a project, update, or document.
- **Fields are projected, not passed through.** The 25 named tools return the fixed
  field sets in the GraphQL fragments (e.g. an issue's state as a name string), so
  anything not in those fragments is simply absent from the result. `linear_graphql`
  passes `data` through raw instead — which is why its coverage is whatever Linear's
  API exposes, and nothing more.
- **`linear_graphql` is uncurated by design.** It validates that the document is a
  non-blank string and that `variables` is an object; it does not validate the
  document against the Linear schema, does not restrict mutations, and does not
  rewrite anything. A malformed document fails on Linear's side as an `{ error }`
  payload, and a valid one executes with your key's full permissions — including
  destructive operations (deletes, archives, unarchives, and anything else the
  Linear schema offers) that no named tool models and that this package does not
  gate. Reach for it when the named tools fall short,
  not instead of them.
- **One workspace per key.** A Linear API key is workspace-scoped; there is no
  multi-workspace switching.

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
- a project name → `projects(filter: { name: { eq: … } })` → the mutation's top-level `id`

If a team key/name does not resolve to exactly one team, the tool fails with a clear
`Team '<x>' not found` error instead of sending a malformed mutation. A project name that
matches more than one project is refused the same way — the resolver will not pick one of
several candidates and update an ambiguous target; it reports that the name matched multiple
projects and asks for the project UUID. An issue identifier is resolved by splitting it into
team key + number and querying `issues(filter: { team: { key: { eq: … } }, number: { eq: … } })`,
since `IssueFilter` has no `identifier` field. That lookup is archived-blind like Linear's own
`issues` query, **except** for `linear_issue_unarchive`, which adds `includeArchived: true` —
without it the one issue class that tool exists to fix would be invisible to its own lookup.

Note that the update/archive mutations do **not** put the target's UUID inside `input`:
`projectUpdate(id:, input:)` and `commentUpdate(id:, input:)` take it as a separate top-level
argument, and `commentDelete(id:)`, `issueArchive(id:)` and `issueUnarchive(id:)` take a bare
`id` at all — there is no `CommentDeleteInput` or archive-input type in the Linear schema. The
archive mutations return their issue under the payload field `entity`, not `issue`.
