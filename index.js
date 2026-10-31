// @kb1slnlabs/dsh-linear — Linear issue-tracking tools for the DeepSeek Harness.
//
// A Cordis function/namespace plugin: exports { name, inject, apply } (NO default
// export — a stray default collapses the module via the Loader's unwrapExports).
// `apply` registers model-facing tools through ctx.tools.register.
//
// One tool surface:
//   GraphQL tools (linear_*): 26 hand-written tools that talk to the Linear
//   GraphQL API (https://api.linear.app/graphql) with a personal API token
//   (env LINEAR_API_KEY, config apiKey, or the key file ~/.config/linear/api-key).
//   There is no MCP server and no MCP
//   client here — no connection to mcp.linear.app is ever opened, and no MCP
//   configuration exists. The 26 tools below are the entire surface.
//
// Peer deps (@deepseek-ai/dsh-tools, @deepseek-ai/cordis) resolve
// from the dsh install's node_modules — this file lives outside any pnpm tree,
// so a plain import would not find them; the resolvers below pin resolution to
// the dsh install root by absolute file:// URL.
//
// GraphQL tools:
//   linear_issue_list      — list issues (filter by team, state, search, limit, cursor pagination)
//   linear_issue_get       — one issue by id or identifier (e.g. "APT-123")
//   linear_issue_create    — create an issue in a team
//   linear_issue_update    — update an issue (state, description, assignee, labels, priority)
//   linear_issue_archive   — archive an issue (id or identifier)
//   linear_issue_unarchive — unarchive a previously archived issue
//   linear_comment_add     — add a comment to an issue
//   linear_comment_update  — update a comment body (comment UUID)
//   linear_comment_delete  — delete a comment (comment UUID)
//   linear_comment_list    — list comments on an issue (cursor pagination)
//   linear_relation_add    — link a related issue to an issue
//   linear_team_list       — list teams
//   linear_team_get        — one team by id (UUID) or key
//   linear_state_list      — list workflow states for a team
//   linear_label_list      — list labels for a team
//   linear_label_get       — one label by id (UUID)
//   linear_label_create    — create a label for a team
//   linear_project_list    — list projects
//   linear_project_get     — one project by id (UUID)
//   linear_project_create  — create a project
//   linear_project_update  — update a project (name, description, content, dates, teams)
//   linear_cycle_list      — list cycles for a team
//   linear_cycle_get       — one cycle by id (UUID)
//   linear_user_list       — list users in the workspace
//   linear_user_get        — one user by id (UUID) or email
//   linear_graphql         — direct GraphQL escape hatch (caller's own query or
//                            mutation document; coverage is whatever the Linear
//                            API exposes to the key, not named-tool parity)

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

// The plugin source lives outside any pnpm tree, so a bare import('@deepseek-ai/dsh-tools')
// cannot resolve from here. Every dependency is therefore requested as a STANDARD bare
// specifier ('@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery') and resolved through the
// packages' own "exports" maps — never through a hardcoded entry filename. Node's own resolver
// walks up from this file, so
// when the plugin is installed inside a tree that carries these packages (or one of their
// peer locations), plain resolution finds them with no anchoring at all. Only when that
// fails do we fall back to resolving from the dsh install root, derived portably from
// process.execPath (the npm-global prefix layout on any platform), and only as a last
// resort is the historical Windows %APPDATA% location probed.
//
// We use import() (NOT require()): a synchronous require() of dsh-tools — an ESM module —
// at module-eval time races the harness's own concurrent import() of the same module and
// trips Node's ERR_INTERNAL_ASSERTION ("module status 0 ... not yet fully loaded").
// import() of an absolute file:// URL awaits the same module job and is race-free.
//
// Resolution order for every dependency below (identical shape):
//   1. the DSH_LINEAR_* override env var (explicit entry, any resolvable path/URL)
//   2. for @deepseek-ai/dsh-tools only: the same bare specifier resolved from the
//      running DSH process entry point (process.argv[1], when it is an absolute
//      existing path), so defineTool comes from the host that launched us
//   3. plain Node resolution of the bare specifier from this file
//   4. the same bare specifier resolved from the dsh install root
//
// Step 2 exists because a full copy of @deepseek-ai/dsh-tools installed next to this
// plugin is a SECOND instance of that package. The DSH PTC scheduler keeps its state on
// a private per-module Symbol, so a tool compiled by one dsh-tools instance and executed
// by another trips "Cannot read properties of undefined (reading 'prepare')". That
// cross-instance failure is a reproducible mechanism, and it is the leading explanation
// for the live error this packaging change targets — not a proven account of which copy
// was loaded in that session. Binding defineTool to the host's own copy removes the
// condition either way. @deepseek-ai/schemastery keeps its original resolution order —
// it carries no such per-module state.

/** Resolve a bare specifier to a file:// URL, or undefined if nothing provides it. */
function tryResolveFrom(fromFile, specifier) {
  try {
    return pathToFileURL(createRequire(fromFile).resolve(specifier)).href
  } catch {
    return undefined
  }
}

/** This file's path — the anchor for plain (package.json-driven) resolution. */
const selfPath = fileURLToPath(import.meta.url)

/**
 * Anchor for host-side resolution: the entry point of the process that is running us, taken
 * from process.argv[1] and accepted only when it is an absolute path that exists. Resolving
 * '@deepseek-ai/dsh-tools' from the host's own module tree hands back the SAME instance the
 * harness already loaded — which is what keeps defineTool bound to the host runtime rather
 * than a second copy installed beside this plugin, and is why this anchor exists even though
 * the live error it defends against has not been attributed to a specific loaded copy.
 * Derived from process.argv[1] alone — no
 * hardcoded machine paths — and undefined for any other shape (relative path, missing file,
 * REPL with no argv[1]).
 */
function dshProcessEntryAnchor() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || !entry.trim() || !isAbsolute(entry)) return undefined
  if (!existsSync(entry)) return undefined
  return entry
}

/**
 * Anchor for peer resolution inside a dsh install: the installed @deepseek-ai/dsh package
 * itself, located by walking up from process.execPath to the nearest ancestor that carries
 * .../node_modules/@deepseek-ai/dsh/package.json. execPath-based (not a hardcoded home
 * directory) so it works for any npm/pnpm global prefix on Windows, macOS or Linux.
 */
function dshInstallAnchor() {
  let dir = dirname((process.execPath || '').replace(/[\\/]+$/, '') || '.')
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (tryResolveFrom(join(dir, 'noop.js'), '@deepseek-ai/dsh/package.json')) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Portable fallback anchors for the dsh install's node_modules, in preference order:
 *   1. npm/pnpm global prefix derived from process.execPath (<prefix>/node_modules)
 *   2. %APPDATA%/npm/node_modules (the historical Windows npm-global location)
 *   3. /usr/local/lib/node_modules and /usr/lib/node_modules (POSIX npm-global defaults)
 */
function fallbackNodeModulesRoots() {
  const roots = []
  const execPath = (process.execPath || '').replace(/\\/g, '/')
  const marker = '/node_modules/'
  const idx = execPath.lastIndexOf(marker)
  if (idx !== -1) roots.push(execPath.slice(0, idx + '/node_modules'.length))
  if (process.platform === 'win32') {
    roots.push(join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules'))
  } else {
    roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  }
  return roots
}

/**
 * Resolve one bare specifier: plain resolution from this file first, then the dsh install
 * anchor, then each fallback node_modules root. `override` (a DSH_LINEAR_* env var) wins
 * over all of them when set. The final entry is the resolved file:// URL, so import() stays
 * race-free; if nothing resolves, the plain specifier is returned so import() raises Node's
 * own module-not-found error.
 *
 * @deepseek-ai/dsh-tools is NOT a peer installed beside this plugin any more: it is provided
 * by the host dsh install (declared as an optional peer so no package manager installs or
 * hoists its own copy over the runtime's). That is why resolveDshToolsEntry() prefers the
 * running process's entry point — see dshProcessEntryAnchor. schemastery keeps this shape.
 */
function resolveEntry(override, specifier) {
  if (override) return override
  return tryResolveFrom(selfPath, specifier) ?? tryResolveFrom(dshInstallAnchor(), specifier) ?? tryResolveFromFromRoots(specifier) ?? specifier
}

/** Last resort: the same bare specifier resolved from each npm-global fallback root. */
function tryResolveFromFromRoots(specifier) {
  for (const root of fallbackNodeModulesRoots()) {
    const entry = tryResolveFrom(join(root, 'noop.js'), specifier)
    if (entry !== undefined) return entry
  }
  return undefined
}

/**
 * dsh-tools specifically: the host process's own copy first, then the usual chain. The
 * process-entry anchor comes BEFORE plain resolution from this file on purpose — a copy of
 * dsh-tools sitting in this plugin's node_modules (devDependency, or left over from an older
 * install) would win and give us a second instance whose private per-module Symbol
 * the host scheduler cannot see; that is the failure mode this order defends against,
 * whether or not such a copy was ever actually loaded in a given session.
 */
function resolveDshToolsEntry() {
  const specifier = '@deepseek-ai/dsh-tools'
  const override = process.env.DSH_LINEAR_TOOLS
  if (override) return override
  return tryResolveFrom(dshProcessEntryAnchor(), specifier) ?? tryResolveFrom(selfPath, specifier) ?? tryResolveFrom(dshInstallAnchor(), specifier) ?? tryResolveFromFromRoots(specifier) ?? specifier
}

// Same resolution chain, but for the schemastery schema lib (used to declare the plugin Config).
function resolveDshSchemasteryEntry() {
  return resolveEntry(process.env.DSH_LINEAR_SCHEMA, '@deepseek-ai/schemastery')
}

const { defineTool } = await import(resolveDshToolsEntry())
// schemastery's exports map serves the ESM entry to an import in a tree that provides it;
// resolved from the dsh install root the same specifier may land on its CJS entry, which
// Node wraps with both `default` and the named bindings. Take whichever shape is real.
const schemastery = await import(resolveDshSchemasteryEntry())
const z = typeof schemastery.default?.object === 'function' ? schemastery.default : schemastery

const name = 'linear'
const inject = ['tools']

const API_URL = 'https://api.linear.app/graphql'

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

// Credential resolution order — precedence is fixed and never widened:
//   1. config.apiKey (non-empty patch-row value)
//   2. LINEAR_API_KEY environment variable
//   3. the standard local key file ~/.config/linear/api-key, i.e.
//      join(homedir(), '.config', 'linear', 'api-key')
// The key file is read with fs only — no subprocess, no network — and its
// contents are never logged or written anywhere; only the trimmed string is
// returned. A missing, unreadable, or blank file is simply "no key": it falls
// through to the same clear configuration error as the other two sources.
// The path is resolved per call, so a test that isolates its own home directory
// by pointing HOME/USERPROFILE at a throwaway directory is honoured without a
// restart. There is no key-file override env var: the path is exactly the one
// above, and nothing widens it or changes the precedence.
function keyFilePath() {
  return join(homedir(), '.config', 'linear', 'api-key')
}

// The key-file path is resolved per call so homedir() (and therefore the home
// directory a test isolates itself in) is read fresh each time.
function readKeyFile() {
  try {
    const raw = readFileSync(keyFilePath(), 'utf8')
    const trimmed = raw.trim()
    return trimmed || undefined
  } catch {
    // Missing file, a directory where the key file should be, or a permission
    // error — all mean "no key from the file". The reason is deliberately not
    // surfaced: it must never be the file's contents.
    return undefined
  }
}

function resolveKey(config) {
  const key = config?.apiKey || process.env.LINEAR_API_KEY || readKeyFile()
  if (!key) throw new Error('Linear API key not configured: set the LINEAR_API_KEY environment variable, pass `apiKey` in plugin config, or put the key in ~/.config/linear/api-key.')
  return key
}

async function gql(key, query, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Linear API keys are sent as the raw Authorization value — NOT "Bearer <key>".
      Authorization: key,
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.errors?.length) {
    const msg = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    throw new Error(`Linear API error: ${msg}`)
  }
  return body.data
}

// ---------------------------------------------------------------------------
// Field fragments
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = `
  id identifier title description state { id name type }
  assignee { id name }
  priority
  createdAt updatedAt
  labels { nodes { id name } }
  project { id name }
  url
`

// Connection pagination block for list connections (issues, comments). Every
// direct list tool that supports `after` requests this alongside `nodes`.
const PAGE_INFO_FIELDS = `
  pageInfo { hasNextPage endCursor }
`

const COMMENT_FIELDS = `
  id body createdAt
`

const TEAM_FIELDS = `
  id name key description
`

const STATE_FIELDS = `
  id name type position
`

const LABEL_FIELDS = `
  id name color description
`

const PROJECT_FIELDS = `
  id name description state
  teams { id name key }
`

const CYCLE_FIELDS = `
  id number name startsAt endsAt completedAt
  progress
  team { id name key }
`

const USER_FIELDS = `
  id name displayName email active
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Cursor pagination (direct GraphQL list tools).
//
// `after` is an optional opaque cursor: it is ALWAYS sent as a GraphQL variable
// (`$after: String`), never interpolated into the query text, so a cursor can
// never alter the document. When no cursor is supplied the declaration and the
// `after:` argument are both omitted, which keeps the wire request byte-identical
// to the pre-pagination form (backwards compatibility). Every direct list tool
// uses this shape: linear_issue_list, linear_comment_list, linear_team_list,
// linear_state_list, linear_label_list, linear_project_list, linear_cycle_list
// and linear_user_list.
// The result shape mirrors GraphQL's PageInfo — null when the server did not
// report one, so an older/blank response never invents pagination state.
function normalizePageInfo(pageInfo) {
  if (!pageInfo || typeof pageInfo !== 'object') return null
  return {
    hasNextPage: pageInfo.hasNextPage === true,
    endCursor: typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null,
  }
}

// ---------------------------------------------------------------------------
// Entity resolution (resolve-then-mutate)
// ---------------------------------------------------------------------------
//
// Linear's GraphQL inputs are FLAT UUID fields — there is no nested
// `team`/`state` object on IssueCreateInput/IssueUpdateInput, and the singular
// `Query.team` field accepts ONLY a UUID `id` (no `key`/`name`/`filter`).
// So every human-facing identifier (team key, state name) must first be
// resolved to a UUID through the PLURAL `teams` / `workflowStates` query
// fields, which DO accept filters:
//
//   teams(filter: { key: { eq: "APT" } }) { nodes { id key name } }
//   workflowStates(filter: { team: { id: { eq: <teamId> } },
//                           name: { eq: "Backlog" } }) { nodes { id name } }
//
// The resolvers below throw a clear error when the identifier does not resolve
// to exactly one entity, so a bad key never reaches a mutation as a malformed
// nested object.

// Resolve a team key or name to its UUID via the PLURAL `teams` field (which
// accepts a TeamFilter). Pass a UUID through unchanged.
async function resolveTeamId(key, ref) {
  if (UUID_RE.test(ref)) return ref
  const isEmail = ref.includes('@')
  const data = await gql(key, `
    query($v: String!) {
      teams(first: 10, filter: { ${isEmail ? 'name' : 'key'}: { eq: $v } }) {
        nodes { id key name }
      }
    }
  `, { v: ref })
  const nodes = data.teams?.nodes ?? []
  if (nodes.length !== 1) {
    throw new Error(`Team '${ref}' not found (resolved ${nodes.length} teams via the teams filter)`)
  }
  return nodes[0].id
}

// Resolve a workflow-state name to its UUID within a team (UUID required).
// Uses the top-level `workflowStates` query field, filtered by team id + name.
async function resolveStateId(key, teamId, stateName) {
  const data = await gql(key, `
    query($teamId: String!, $name: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
        nodes { id name }
      }
    }
  `, { teamId, name: stateName })
  const nodes = data.workflowStates?.nodes ?? []
  if (nodes.length !== 1) {
    throw new Error(`State '${stateName}' not found for team ${teamId} (resolved ${nodes.length} states)`)
  }
  return nodes[0].id
}

// Resolve a project name or a UUID to a Linear project UUID. The singular
// `project` field accepts ONLY a UUID id, so a name goes through the PLURAL
// `projects` field (which takes a ProjectFilter). Unlike teams, a non-UUID that
// simply matches nothing returns null here rather than throwing, so the caller
// renders the same `Project not found: <x>` shape the read tools use.
// More than one node is NOT silently shortened to the first one: an update aimed
// at an ambiguous name could modify the wrong project, so it throws and
// resolveLinearProjectId turns that into a clean { error } before any mutation.
async function findProjectId(key, ref) {
  if (UUID_RE.test(ref)) return ref
  const data = await gql(key, `
    query($name: String!) {
      projects(filter: { name: { eq: $name } }) {
        nodes { id }
      }
    }
  `, { name: ref })
  const nodes = data.projects?.nodes ?? []
  if (nodes.length > 1) {
    throw new Error(`Project name '${ref}' is ambiguous (resolved ${nodes.length} projects via the projects filter); use the project id (UUID) instead`)
  }
  return nodes[0]?.id ?? null
}

// findProjectId with its two failure shapes rendered for a tool: `null` means
// genuinely not found, and an ambiguity throw becomes its own clean error string.
async function resolveLinearProjectId(key, ref) {
  try {
    const projectId = await findProjectId(key, ref)
    return { projectId }
  } catch (err) {
    if (/is ambiguous/.test(err?.message ?? '')) {
      return { error: `Project name '${ref}' matched multiple projects — refine the name or use the project id (UUID)` }
    }
    throw err
  }
}

// Resolve a human identifier ("APT-804") or a UUID to a Linear issue UUID.
// IssueFilter has no `identifier` field, so we split the identifier into
// team key + number and look the issue up by those, then return its id.
// `includeArchived` opts into IssuesQuery.includeArchived: an ARCHIVED issue is
// invisible to the plain issues query, so a tool that must reach one (only
// linear_issue_unarchive) passes it. Every other caller omits the option, which
// keeps the document byte-for-byte what it was before — no extra argument and
// no extra variable are sent when includeArchived is falsy.
async function findIssueId(key, id, { includeArchived = false } = {}) {
  if (UUID_RE.test(id)) return id
  const m = id.match(/^(.+?)-(\d+)$/)
  if (!m) return null
  const [, teamKey, num] = m
  const data = await gql(key, `
    query($team: String!, $num: Float!) {
      issues(filter: { team: { key: { eq: $team } }, number: { eq: $num } }${includeArchived ? ', includeArchived: true' : ''}) {
        nodes { id }
      }
    }
  `, { team: teamKey, num: Number(num) })
  return data.issues.nodes[0]?.id ?? null
}

// Shared body for linear_issue_archive / linear_issue_unarchive. Both mutations
// take a bare `id` argument (there is no IssueArchiveInput type) and both return
// IssueArchivePayload { success entity lastSyncId } — the archived issue comes
// back under `entity`, NOT `issue` (verified by introspection). The identifier is
// resolved to a UUID first, so an unknown "APT-999" fails before any mutation.
// Unarchiving resolves the identifier with includeArchived: true, because an
// archived issue is exactly what the plain issues query hides — without it the
// tool could never unarchive anything it identified by name. Archiving keeps the
// ordinary lookup (an archived issue needs no second archive).
async function archiveIssue(key, id, unarchive) {
  const issueId = await findIssueId(key, id, { includeArchived: unarchive })
  if (!issueId) return JSON.stringify({ error: `Issue not found: ${id}` })
  const mutation = unarchive ? 'issueUnarchive' : 'issueArchive'
  const data = await gql(key, `
    mutation($id: String!) {
      ${mutation}(id: $id) {
        success entity { ${ISSUE_FIELDS} }
      }
    }
  `, { id: issueId })
  const payload = data[mutation]
  if (!payload?.success) return JSON.stringify({ error: `${mutation} failed` })
  const i = payload.entity
  if (!i) return JSON.stringify({ ok: true, archived: !unarchive })
  return JSON.stringify({
    ok: true,
    archived: !unarchive,
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    state: i.state?.name,
    url: i.url,
  }, null, 2)
}

// ---------------------------------------------------------------------------
// GraphQL tools
// ---------------------------------------------------------------------------

function registerLinearTools(ctx, config) {
  const key = () => resolveKey(config)

  // Wrap only Linear tools so any failure (a resolution error like
  // "Team 'X' not found", a Linear API error, or a network error) surfaces as
  // a clean JSON { error } payload instead of a thrown stack trace. The
  // resolution helpers throw deliberately; this guard turns that into the
  // clear, model-readable error the bug report requires.
  const originalRegister = ctx.tools.register.bind(ctx.tools)
  const register = (def) =>
    originalRegister({
      ...def,
      execute: async (args, opts) => {
        try {
          return await def.execute(args, opts)
        } catch (err) {
          return JSON.stringify({ error: err?.message || String(err) })
        }
      },
    })

  // -- Issues ---------------------------------------------------------------

  register(
    defineTool({
      name: 'linear_issue_list',
      description:
        'List Linear issues. Optionally filter by team key (e.g. "APT"), state name, or free-text search. Returns up to `limit` most recent issues (default 20, max 50). Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        team: { type: 'string', description: 'Team key to filter by, e.g. "APT"' },
        state: { type: 'string', description: 'State name to filter by, e.g. "Done", "In Progress"' },
        search: { type: 'string', description: 'Free-text search across title/description' },
        limit: { type: 'number', description: 'Max issues to return (default 20, max 50)' },
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        const filterParts = []
        const vars = {}
        if (args.team) { filterParts.push(`team: { key: { eq: $team } }`); vars.team = args.team }
        if (args.state) { filterParts.push(`state: { name: { eq: $state } }`); vars.state = args.state }
        if (args.search) { filterParts.push(`OR: { title: { containsInsensitive: $search }, description: { containsInsensitive: $search } }`); vars.search = args.search }
        const filter = filterParts.length ? `filter: { ${filterParts.join(', ')} }` : ''
        if (after !== undefined) vars.after = after
        const usedVars = Object.keys(vars)
        const varDecl = usedVars.length ? `query(${usedVars.map((v) => `$${v}: String`).join(', ')})` : 'query'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = [filter, after !== undefined ? 'after: $after' : null].filter(Boolean).join(', ')
        const data = await gql(key(), `
          ${varDecl} {
            issues(first: ${limit}${argList ? `, ${argList}` : ''}) {
              nodes { ${ISSUE_FIELDS} }
              ${PAGE_INFO_FIELDS}
            }
          }
        `, vars)
        const issues = data.issues.nodes.map((i) => ({
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          state: i.state?.name,
          assignee: i.assignee?.name,
          priority: i.priority,
          project: i.project?.name,
          labels: i.labels.nodes.map((l) => l.name),
          url: i.url,
        }))
        return JSON.stringify({ count: issues.length, issues, pageInfo: normalizePageInfo(data.issues.pageInfo) }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_issue_get',
      description:
        'Get a single Linear issue by its id (UUID) or identifier (e.g. "APT-123"). Returns full details including description, state, assignee, labels, project, and relations.',
      parameters: {
        id: { type: 'string', required: true, description: 'Issue id (UUID) or identifier like "APT-123"' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const issueId = await findIssueId(key(), args.id)
        if (!issueId) return JSON.stringify({ error: `Issue not found: ${args.id}` })
        const data = await gql(key(), `
          query($id: String!) {
            issue: issue(id: $id) {
              ${ISSUE_FIELDS}
              relations { nodes { type relatedIssue { ${ISSUE_FIELDS} } } }
            }
          }
        `, { id: issueId })
        const i = data.issue
        if (!i) return JSON.stringify({ error: `Issue not found: ${args.id}` })
        return JSON.stringify({
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          description: i.description,
          state: i.state?.name,
          assignee: i.assignee?.name,
          priority: i.priority,
          project: i.project?.name,
          labels: i.labels.nodes.map((l) => l.name),
          relations: (i.relations?.nodes ?? i.relations ?? []).map((r) => r.relatedIssue && { id: r.relatedIssue.id, identifier: r.relatedIssue.identifier, title: r.relatedIssue.title, type: r.type }),
          url: i.url,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_issue_create',
      description:
        'Create a new Linear issue in a team. `team` is the team key (e.g. "APT"). Optional: title (required), description, state name, assignee id, label ids, priority (0-4).',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
        title: { type: 'string', required: true, description: 'Issue title' },
        description: { type: 'string', description: 'Issue description (markdown)' },
        state: { type: 'string', description: 'Initial state name, e.g. "Todo", "In Progress"' },
        assignee: { type: 'string', description: 'Assignee user id (UUID)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label ids (UUIDs) to attach' },
        priority: { type: 'number', description: 'Priority 0 (none) to 4 (urgent)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // Resolve human identifiers to UUIDs first (IssueCreateInput is flat:
        // teamId is required, stateId/assigneeId/labelIds are UUIDs).
        const teamId = await resolveTeamId(key(), args.team)
        const input = { teamId, title: args.title }
        if (args.description) input.description = args.description
        if (args.state) input.stateId = await resolveStateId(key(), teamId, args.state)
        if (args.assignee) input.assigneeId = args.assignee
        if (args.labels?.length) input.labelIds = args.labels
        if (args.priority !== undefined) input.priority = args.priority
        const data = await gql(key(), `
          mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success issue { ${ISSUE_FIELDS} }
            }
          }
        `, { input })
        if (!data.issueCreate.success) return JSON.stringify({ error: 'issueCreate failed' })
        const i = data.issueCreate.issue
        return JSON.stringify({
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          state: i.state?.name,
          url: i.url,
        }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_issue_update',
      description:
        'Update an existing Linear issue by id (UUID) or identifier. Any of: state name, description, assignee id, label ids, priority (0-4), title.',
      parameters: {
        id: { type: 'string', required: true, description: 'Issue id (UUID) or identifier' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description (markdown)' },
        state: { type: 'string', description: 'New state name, e.g. "Done", "In Progress"' },
        assignee: { type: 'string', description: 'New assignee user id (UUID); empty string to unassign' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label ids to set (replaces existing)' },
        priority: { type: 'number', description: 'Priority 0-4' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const issueId = await findIssueId(key(), args.id)
        if (!issueId) return JSON.stringify({ error: `Issue not found: ${args.id}` })

        // IssueUpdateInput is flat (stateId/assigneeId/labelIds are UUIDs).
        // A state change needs the issue's team to resolve the state name.
        const input = { id: issueId }
        if (args.title !== undefined) input.title = args.title
        if (args.description !== undefined) input.description = args.description
        if (args.assignee !== undefined) input.assigneeId = args.assignee || null
        if (args.labels !== undefined) input.labelIds = args.labels
        if (args.priority !== undefined) input.priority = args.priority
        if (args.state !== undefined) {
          const issueData = await gql(key(), `
            query($id: String!) {
              issue: issue(id: $id) { id team { id } }
            }
          `, { id: issueId })
          const teamId = issueData.issue?.team?.id
          if (!teamId) return JSON.stringify({ error: `Could not resolve team for issue ${args.id}` })
          input.stateId = await resolveStateId(key(), teamId, args.state)
        }

        const data = await gql(key(), `
          mutation($input: IssueUpdateInput!) {
            issueUpdate(input: $input) {
              success issue { ${ISSUE_FIELDS} }
            }
          }
        `, { input })
        if (!data.issueUpdate.success) return JSON.stringify({ error: 'issueUpdate failed' })
        const i = data.issueUpdate.issue
        return JSON.stringify({
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          state: i.state?.name,
          assignee: i.assignee?.name,
          url: i.url,
        }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_issue_archive',
      description:
        'Archive a Linear issue by id (UUID) or identifier. Archived issues leave the team\'s default views. To bring an archived issue back, use the separate linear_issue_unarchive tool — this tool takes no unarchive argument.',
      parameters: {
        id: { type: 'string', required: true, description: 'Issue id (UUID) or identifier' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        return archiveIssue(key(), args.id, false)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_issue_unarchive',
      description: 'Unarchive a previously archived Linear issue by id (UUID) or identifier, returning it to the team\'s views.',
      parameters: {
        id: { type: 'string', required: true, description: 'Issue id (UUID) or identifier' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        return archiveIssue(key(), args.id, true)
      },
    }),
  )

  // -- Comments ---------------------------------------------------------------

  register(
    defineTool({
      name: 'linear_comment_add',
      description: 'Add a comment to a Linear issue (by id or identifier).',
      parameters: {
        issue: { type: 'string', required: true, description: 'Issue id or identifier' },
        body: { type: 'string', required: true, description: 'Comment body (markdown)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const issueId = await findIssueId(key(), args.issue)
        if (!issueId) return JSON.stringify({ error: `Issue not found: ${args.issue}` })
        const data = await gql(key(), `
          mutation($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success comment { ${COMMENT_FIELDS} }
            }
          }
        `, { input: { issueId, body: args.body } })
        if (!data.commentCreate.success) return JSON.stringify({ error: 'commentCreate failed' })
        return JSON.stringify({ id: data.commentCreate.comment.id, body: data.commentCreate.comment.body }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_comment_list',
      description: 'List comments on a Linear issue (by id or identifier), newest first. Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        issue: { type: 'string', required: true, description: 'Issue id or identifier' },
        limit: { type: 'number', description: 'Max comments (default 20, max 50)' },
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        const issueId = await findIssueId(key(), args.issue)
        if (!issueId) return JSON.stringify({ error: `Issue not found: ${args.issue}` })
        const vars = { id: issueId }
        if (after !== undefined) vars.after = after
        const varDecl = after !== undefined ? 'query($id: String!, $after: String)' : 'query($id: String!)'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = after !== undefined ? 'after: $after' : ''
        const data = await gql(key(), `
          ${varDecl} {
            issue: issue(id: $id) {
              id
              comments(first: ${limit}${argList ? `, ${argList}` : ''}) {
                nodes { ${COMMENT_FIELDS} }
                ${PAGE_INFO_FIELDS}
              }
            }
          }
        `, vars)
        if (!data.issue) return JSON.stringify({ error: `Issue not found: ${args.issue}` })
        return JSON.stringify({
          issue: args.issue,
          count: data.issue.comments.nodes.length,
          comments: data.issue.comments.nodes,
          pageInfo: normalizePageInfo(data.issue.comments.pageInfo),
        }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_comment_update',
      description: 'Update the body of an existing comment on a Linear issue. `id` is the comment UUID (from linear_comment_list); `body` is the new markdown body.',
      parameters: {
        id: { type: 'string', required: true, description: 'Comment id (UUID)' },
        body: { type: 'string', required: true, description: 'New comment body (markdown)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // CommentUpdateInput carries only the changed fields; the comment UUID is
        // a top-level `id` argument on the mutation (verified by introspection).
        const data = await gql(key(), `
          mutation($id: String!, $input: CommentUpdateInput!) {
            commentUpdate(id: $id, input: $input) {
              success comment { ${COMMENT_FIELDS} }
            }
          }
        `, { id: args.id, input: { body: args.body } })
        if (!data.commentUpdate.success) return JSON.stringify({ error: 'commentUpdate failed' })
        const c = data.commentUpdate.comment
        return JSON.stringify({ id: c?.id, body: c?.body }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_comment_delete',
      description: 'Delete a comment from a Linear issue by its comment id (UUID, from linear_comment_list). This is destructive and cannot be undone.',
      parameters: {
        id: { type: 'string', required: true, description: 'Comment id (UUID)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // commentDelete takes a bare `id` argument — there is NO CommentDeleteInput
        // type in the Linear schema (verified by introspection). Its payload is
        // DeletePayload { success entityId lastSyncId } — no entity object.
        const data = await gql(key(), `
          mutation($id: String!) {
            commentDelete(id: $id) {
              success entityId
            }
          }
        `, { id: args.id })
        if (!data.commentDelete.success) return JSON.stringify({ error: 'commentDelete failed' })
        return JSON.stringify({ ok: true, deletedId: data.commentDelete.entityId ?? args.id }, null, 2)
      },
    }),
  )

  // -- Relations --------------------------------------------------------------

  register(
    defineTool({
      name: 'linear_relation_add',
      description:
        'Link a related issue to an issue. Both given by id or identifier. `type` is the relation type (default "related").',
      parameters: {
        issue: { type: 'string', required: true, description: 'Source issue id or identifier' },
        related: { type: 'string', required: true, description: 'Related issue id or identifier' },
        type: { type: 'string', description: 'Relation type: related, blockedBy, blocks, parent, child (default "related")' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const type = args.type ?? 'related'
        const VALID_RELATION_TYPES = ['related', 'blockedBy', 'blocks', 'parent', 'child']
        if (!VALID_RELATION_TYPES.includes(type)) {
          return JSON.stringify({ error: `invalid relation type: ${type}, expected one of: ${VALID_RELATION_TYPES.join(', ')}` })
        }
        const [issueId, relatedId] = await Promise.all([
          findIssueId(key(), args.issue),
          findIssueId(key(), args.related),
        ])
        if (!issueId) return JSON.stringify({ error: `Issue not found: ${args.issue}` })
        if (!relatedId) return JSON.stringify({ error: `Issue not found: ${args.related}` })
        const data = await gql(key(), `
          mutation($input: IssueRelationCreateInput!) {
            issueRelationCreate(input: $input) {
              success relation { id }
            }
          }
        `, { input: { issueId, relatedIssueId: relatedId, type } })
        if (!data.issueRelationCreate.success) return JSON.stringify({ error: 'issueRelationCreate failed' })
        return JSON.stringify({ ok: true, relationId: data.issueRelationCreate.relation.id }, null, 2)
      },
    }),
  )

  // -- Teams / states / labels / projects -------------------------------------

  register(
    defineTool({
      name: 'linear_team_list',
      description: 'List all Linear teams (key, name, description). Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        const vars = {}
        if (after !== undefined) vars.after = after
        const varDecl = after !== undefined ? 'query($after: String)' : 'query'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = [after !== undefined ? 'after: $after' : null].filter(Boolean).join(', ')
        const data = await gql(key(), `
          ${varDecl} {
            teams(first: 100${argList ? `, ${argList}` : ''}) {
              nodes { ${TEAM_FIELDS} }
              ${PAGE_INFO_FIELDS}
            }
          }
        `, vars)
        return JSON.stringify({ count: data.teams.nodes.length, teams: data.teams.nodes, pageInfo: normalizePageInfo(data.teams.pageInfo) }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_state_list',
      description: 'List workflow states for a team (e.g. Todo, In Progress, Done). Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        // Resolve the team to a UUID via the PLURAL `teams` field (the singular
        // `team` field takes only a UUID id), then list that team's states via
        // the top-level `workflowStates` field filtered by team id.
        const teamId = await resolveTeamId(key(), args.team)
        const vars = { teamId }
        if (after !== undefined) vars.after = after
        const varDecl = after !== undefined ? 'query($teamId: String!, $after: String)' : 'query($teamId: String!)'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = [after !== undefined ? 'after: $after' : null].filter(Boolean).join(', ')
        const data = await gql(key(), `
          ${varDecl} {
            workflowStates(filter: { team: { id: { eq: $teamId } } }${argList ? `, ${argList}` : ''}) {
              nodes { ${STATE_FIELDS} }
              ${PAGE_INFO_FIELDS}
            }
          }
        `, vars)
        return JSON.stringify({ team: args.team, states: data.workflowStates.nodes, pageInfo: normalizePageInfo(data.workflowStates.pageInfo) }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_label_list',
      description: 'List labels for a team. Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        const teamId = await resolveTeamId(key(), args.team)
        const vars = { teamId }
        if (after !== undefined) vars.after = after
        const varDecl = after !== undefined ? 'query($teamId: String!, $after: String)' : 'query($teamId: String!)'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = [after !== undefined ? 'after: $after' : null].filter(Boolean).join(', ')
        const data = await gql(key(), `
          ${varDecl} {
            issueLabels(filter: { team: { id: { eq: $teamId } } }${argList ? `, ${argList}` : ''}) {
              nodes { ${LABEL_FIELDS} }
              ${PAGE_INFO_FIELDS}
            }
          }
        `, vars)
        return JSON.stringify({ team: args.team, labels: data.issueLabels.nodes, pageInfo: normalizePageInfo(data.issueLabels.pageInfo) }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_project_list',
      description: 'List Linear projects (name, description, state, teams). Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        limit: { type: 'number', description: 'Max projects (default 20, max 50)' },
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        const vars = {}
        if (after !== undefined) vars.after = after
        const varDecl = after !== undefined ? 'query($after: String)' : 'query'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = [after !== undefined ? 'after: $after' : null].filter(Boolean).join(', ')
        const data = await gql(key(), `
          ${varDecl} {
            projects(first: ${limit}${argList ? `, ${argList}` : ''}) {
              nodes { ${PROJECT_FIELDS} }
              ${PAGE_INFO_FIELDS}
            }
          }
        `, vars)
        return JSON.stringify({ count: data.projects.nodes.length, projects: data.projects.nodes, pageInfo: normalizePageInfo(data.projects.pageInfo) }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_project_create',
      description: 'Create a Linear project. `name` required; optional description and team keys to include.',
      parameters: {
        name: { type: 'string', required: true, description: 'Project name' },
        description: { type: 'string', description: 'Project description' },
        teams: { type: 'array', items: { type: 'string' }, description: 'Team keys to include in the project' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const input = { name: args.name }
        if (args.description) input.description = args.description
        if (args.teams?.length) {
          // ProjectCreateInput takes flat team UUIDs (teamIds), not nested keys.
          input.teamIds = await Promise.all(args.teams.map((t) => resolveTeamId(key(), t)))
        }
        const data = await gql(key(), `
          mutation($input: ProjectCreateInput!) {
            projectCreate(input: $input) {
              success project { ${PROJECT_FIELDS} }
            }
          }
        `, { input })
        if (!data.projectCreate.success) return JSON.stringify({ error: 'projectCreate failed' })
        return JSON.stringify(data.projectCreate.project, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_project_update',
      description:
        'Update a Linear project by id (UUID) or exact name. Any of: name, description, content, icon, color, team keys, start date, target date, priority.',
      parameters: {
        id: { type: 'string', required: true, description: 'Project id (UUID) or exact project name' },
        name: { type: 'string', description: 'New project name' },
        description: { type: 'string', description: 'New project description' },
        content: { type: 'string', description: 'New project content (markdown)' },
        icon: { type: 'string', description: 'Project icon identifier, e.g. "Rocket"' },
        color: { type: 'string', description: 'Hex color, e.g. "#ff0000"' },
        teams: { type: 'array', items: { type: 'string' }, description: 'Team keys to set (replaces existing)' },
        startDate: { type: 'string', description: 'Start date, YYYY-MM-DD' },
        targetDate: { type: 'string', description: 'Target date, YYYY-MM-DD' },
        priority: { type: 'number', description: 'Priority 0 (none) to 4 (urgent)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // A name that matches more than one project never reaches the mutation —
        // resolveLinearProjectId answers with a clean ambiguity error instead.
        const resolved = await resolveLinearProjectId(key(), args.id)
        if (resolved.error) return JSON.stringify({ error: resolved.error })
        const projectId = resolved.projectId
        if (!projectId) return JSON.stringify({ error: `Project not found: ${args.id}` })

        // ProjectUpdateInput is flat (teamIds are UUIDs), and the mutation takes
        // the project UUID as a top-level `id` argument alongside `input`.
        const input = {}
        if (args.name !== undefined) input.name = args.name
        if (args.description !== undefined) input.description = args.description
        if (args.content !== undefined) input.content = args.content
        if (args.icon !== undefined) input.icon = args.icon
        if (args.color !== undefined) input.color = args.color
        if (args.startDate !== undefined) input.startDate = args.startDate
        if (args.targetDate !== undefined) input.targetDate = args.targetDate
        if (args.priority !== undefined) input.priority = args.priority
        if (args.teams !== undefined) {
          input.teamIds = await Promise.all((args.teams ?? []).map((t) => resolveTeamId(key(), t)))
        }

        const data = await gql(key(), `
          mutation($id: String!, $input: ProjectUpdateInput!) {
            projectUpdate(id: $id, input: $input) {
              success project { ${PROJECT_FIELDS} }
            }
          }
        `, { id: projectId, input })
        if (!data.projectUpdate.success) return JSON.stringify({ error: 'projectUpdate failed' })
        return JSON.stringify(data.projectUpdate.project, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_label_create',
      description: 'Create a label for a team.',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
        name: { type: 'string', required: true, description: 'Label name' },
        color: { type: 'string', description: 'Hex color, e.g. "#ff0000"' },
        description: { type: 'string', description: 'Label description' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // LabelCreateInput takes a flat team UUID (teamId), not a nested key.
        const teamId = await resolveTeamId(key(), args.team)
        const data = await gql(key(), `
          mutation($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) {
              success label { ${LABEL_FIELDS} }
            }
          }
        `, {
          input: {
            teamId,
            name: args.name,
            ...(args.color ? { color: args.color } : {}),
            ...(args.description ? { description: args.description } : {}),
          },
        })
        if (!data.issueLabelCreate.success) return JSON.stringify({ error: 'issueLabelCreate failed' })
        return JSON.stringify(data.issueLabelCreate.label, null, 2)
      },
    }),
  )

  // -- Cycles -----------------------------------------------------------------

  register(
    defineTool({
      name: 'linear_cycle_list',
      description: 'List cycles for a team. Returns up to `limit` most recent cycles (default 20, max 50). Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
        limit: { type: 'number', description: 'Max cycles (default 20, max 50)' },
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        const teamId = await resolveTeamId(key(), args.team)
        const vars = { teamId }
        if (after !== undefined) vars.after = after
        const varDecl = after !== undefined ? 'query($teamId: String!, $after: String)' : 'query($teamId: String!)'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = [after !== undefined ? 'after: $after' : null].filter(Boolean).join(', ')
        const data = await gql(key(), `
          ${varDecl} {
            cycles(first: ${limit}, filter: { team: { id: { eq: $teamId } } }${argList ? `, ${argList}` : ''}) {
              nodes { ${CYCLE_FIELDS} }
              ${PAGE_INFO_FIELDS}
            }
          }
        `, vars)
        const cycles = data.cycles.nodes.map((c) => ({
          id: c.id,
          number: c.number,
          name: c.name,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          completedAt: c.completedAt,
        }))
        return JSON.stringify({ team: args.team, count: cycles.length, cycles, pageInfo: normalizePageInfo(data.cycles.pageInfo) }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_cycle_get',
      description: 'Get a single cycle by its id (UUID). Returns full details including team, progress, and dates.',
      parameters: {
        id: { type: 'string', required: true, description: 'Cycle id (UUID)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const data = await gql(key(), `
          query($id: String!) {
            cycle: cycle(id: $id) {
              ${CYCLE_FIELDS}
            }
          }
        `, { id: args.id })
        if (!data.cycle) return JSON.stringify({ error: `Cycle not found: ${args.id}` })
        return JSON.stringify(data.cycle, null, 2)
      },
    }),
  )

  // -- Users ------------------------------------------------------------------

  register(
    defineTool({
      name: 'linear_user_list',
      description: 'List users in the workspace. Returns up to `limit` users (default 20, max 50). Cursor pagination: pass the previous page\'s pageInfo.endCursor as `after` to get the next page; the response includes pageInfo { hasNextPage, endCursor }.',
      parameters: {
        limit: { type: 'number', description: 'Max users (default 20, max 50)' },
        after: { type: 'string', description: 'Cursor from a previous page (pageInfo.endCursor) to fetch the next page' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        // Optional cursor. Kept as a variable (`$after`), never interpolated.
        const after = typeof args.after === 'string' && args.after.trim() ? args.after : undefined
        const vars = {}
        if (after !== undefined) vars.after = after
        const varDecl = after !== undefined ? 'query($after: String)' : 'query'
        // One shared argument list: the cursor is declared only when it is also
        // passed, so a call with no `after` sends exactly the pre-pagination document.
        const argList = [after !== undefined ? 'after: $after' : null].filter(Boolean).join(', ')
        const data = await gql(key(), `
          ${varDecl} {
            users(first: ${limit}${argList ? `, ${argList}` : ''}) {
              nodes { ${USER_FIELDS} }
              ${PAGE_INFO_FIELDS}
            }
          }
        `, vars)
        return JSON.stringify({ count: data.users.nodes.length, users: data.users.nodes, pageInfo: normalizePageInfo(data.users.pageInfo) }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_user_get',
      description: 'Get a single user by id (UUID) or email. Returns full user details.',
      parameters: {
        id: { type: 'string', required: true, description: 'User id (UUID) or email address' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        let user
        if (UUID_RE.test(args.id)) {
          const data = await gql(key(), `
            query($id: String!) {
              user: user(id: $id) { ${USER_FIELDS} }
            }
          `, { id: args.id })
          user = data.user
        } else {
          const data = await gql(key(), `
            query($email: String!) {
              users(filter: { email: { eq: $email } }) {
                nodes { ${USER_FIELDS} }
              }
            }
          `, { email: args.id })
          user = data.users.nodes[0] ?? null
        }
        if (!user) return JSON.stringify({ error: `User not found: ${args.id}` })
        return JSON.stringify(user, null, 2)
      },
    }),
  )

  // -- Single-item getters (project / label / team) ---------------------------

  register(
    defineTool({
      name: 'linear_project_get',
      description: 'Get a single project by its id (UUID). Returns full project details including teams.',
      parameters: {
        id: { type: 'string', required: true, description: 'Project id (UUID)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const data = await gql(key(), `
          query($id: String!) {
            project: project(id: $id) {
              ${PROJECT_FIELDS}
            }
          }
        `, { id: args.id })
        if (!data.project) return JSON.stringify({ error: `Project not found: ${args.id}` })
        return JSON.stringify(data.project, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_label_get',
      description: 'Get a single label by its id (UUID). Returns full label details.',
      parameters: {
        id: { type: 'string', required: true, description: 'Label id (UUID)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const data = await gql(key(), `
          query($id: String!) {
            label: issueLabel(id: $id) {
              ${LABEL_FIELDS}
            }
          }
        `, { id: args.id })
        if (!data.label) return JSON.stringify({ error: `Label not found: ${args.id}` })
        return JSON.stringify(data.label, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_team_get',
      description: 'Get a single team by its id (UUID) or key (e.g. "APT"). Returns full team details.',
      parameters: {
        id: { type: 'string', required: true, description: 'Team id (UUID) or key like "APT"' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        let team
        if (UUID_RE.test(args.id)) {
          const data = await gql(key(), `
            query($id: String!) {
              team: team(id: $id) { ${TEAM_FIELDS} }
            }
          `, { id: args.id })
          team = data.team
        } else {
          // The singular `team` field takes only a UUID id; a key/name must be
          // resolved through the PLURAL `teams` field (which accepts a filter).
          const data = await gql(key(), `
            query($key: String!) {
              teams(first: 10, filter: { key: { eq: $key } }) {
                nodes { ${TEAM_FIELDS} }
              }
            }
          `, { key: args.id })
          const nodes = data.teams?.nodes ?? []
          if (nodes.length !== 1) return JSON.stringify({ error: `Team not found: ${args.id}` })
          team = nodes[0]
        }
        if (!team) return JSON.stringify({ error: `Team not found: ${args.id}` })
        return JSON.stringify(team, null, 2)
      },
    }),
  )

  // -- Direct GraphQL escape hatch -------------------------------------------
  //
  // The one tool that is not a hand-modelled endpoint: it forwards the caller's
  // own GraphQL document to the SAME fixed endpoint (API_URL) with the SAME
  // configured key, through the same gql() client and the same { error } guard
  // every other tool runs under. There is no second endpoint, no extra config,
  // and no credential of its own.
  //
  // Queries AND mutations are allowed — that is the point of the escape hatch —
  // so what a call may actually do is bounded only by the permissions attached to
  // the configured Linear API key, exactly as they are for every other tool here.
  register(
    defineTool({
      name: 'linear_graphql',
      description:
        'Direct GraphQL escape hatch: send an arbitrary GraphQL document (query OR mutation) straight to the Linear API and get the raw `data` back as JSON. Use it for anything the named linear_* tools do not cover — coverage is whatever the Linear GraphQL API exposes to your key, so this is NOT a substitute for named-tool parity and nothing is projected or normalised. `query` is required and must be non-blank; `variables` is an optional object of GraphQL variable values (prefer variables over inlining values into the document). Both queries and mutations are sent as-is: what they may read or change is governed by your Linear API key permissions, so a mutation really writes.',
      parameters: {
        query: { type: 'string', required: true, description: 'The GraphQL document to execute (a query or a mutation)' },
        // Explicit properties keep common variable shapes documented; openness
        // stays true because the document decides which variables exist.
        variables: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional GraphQL variables object, keyed by variable name (e.g. { "id": "<uuid>" })',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // The parameter schema enforces the string; this is the non-blank half of
        // "required nonblank", checked before anything reaches the network.
        if (typeof args.query !== 'string' || !args.query.trim()) {
          return JSON.stringify({ error: '"query" must be a non-empty GraphQL document' })
        }
        const data = await gql(key(), args.query, args.variables)
        // Raw pass-through: the document chooses the shape, so the result is
        // returned as-is rather than projected through a fixed field set.
        return JSON.stringify({ data }, null, 2)
      },
    }),
  )
}

// ---------------------------------------------------------------------------
// Plugin surface
// ---------------------------------------------------------------------------

/**
 * Plugin config:
 *   apiKey: Linear personal API key (li_api_...) for the GraphQL tools.
 *           Falls back to the LINEAR_API_KEY environment variable, and then to
 *           the key file ~/.config/linear/api-key, when unset.
 *
 * There is no other config. The plugin has no MCP side: it neither hosts an
 * MCP server nor connects to one, and it reads no MCP-related setting or
 * environment variable.
 */
// Cordis validates a plugin's `Config` as a Standard Schema (it calls
// Config["~standard"].validate(...)). The real API key still comes from the
// LINEAR_API_KEY env var or the ~/.config/linear/api-key file (see resolveKey);
// this schema only needs to accept an optional `apiKey` string so a patch row
// may also supply one. `.default('')` makes a missing field valid; the empty
// value is ignored by resolveKey, which prefers config.apiKey only when it is
// non-empty and otherwise falls back to env, then the key file.
const Config = z.object({
  apiKey: z.string().default(''),
})

function apply(ctx, config) {
  registerLinearTools(ctx, config)
}

// Cordis's namespace unwrap keys off { name, inject, apply }; this module
// exports exactly that plugin surface and nothing else.
export {
  Config,
  apply,
  inject,
  name,
}
