// @kb1slnlabs/dsh-linear — Linear issue-tracking tools for the DeepSeek Harness.
//
// A Cordis function/namespace plugin: exports { name, inject, apply } (NO default
// export — a stray default collapses the module via the Loader's unwrapExports).
// `apply` registers model-facing tools through ctx.tools.register.
//
// Two tool surfaces:
//   1. GraphQL tools (linear_*): talk to the Linear GraphQL API with a personal
//      API token (env LINEAR_API_KEY or config apiKey). Unchanged behaviour.
//   2. MCP parity tools (linear_mcp_*): dynamic bridge to Linear's HOSTED MCP
//      server over the official Streamable HTTP transport
//      (https://mcp.linear.app/mcp). Tool schemas are DISCOVERED at runtime via
//      `tools/list` and every call is forwarded with `tools/call` using the raw
//      wire name. Credentials are never embedded in tool definitions or names.
//
// Peer deps (@deepseek-ai/dsh-tools, @deepseek-ai/cordis, the MCP SDK) resolve
// from the dsh install's node_modules — this file lives outside any pnpm tree,
// so a plain import would not find them; the resolvers below pin resolution to
// the dsh install root by absolute file:// URL.
//
// GraphQL tools:
//   linear_issue_list    — list issues (filter by team, state, search, limit)
//   linear_issue_get     — one issue by id or identifier (e.g. "APT-123")
//   linear_issue_create  — create an issue in a team
//   linear_issue_update  — update an issue (state, description, assignee, labels, priority)
//   linear_comment_add   — add a comment to an issue
//   linear_comment_list  — list comments on an issue
//   linear_relation_add  — link a related issue to an issue
//   linear_team_list     — list teams
//   linear_state_list    — list workflow states for a team
//   linear_label_list    — list labels for a team
//   linear_project_list  — list projects
//   linear_project_create— create a project
//   linear_label_create  — create a label for a team

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// The plugin source lives outside any pnpm tree, so a bare import('@deepseek-ai/dsh-tools')
// cannot resolve from here. Every dependency is therefore requested as a STANDARD bare
// specifier ('@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'zod/v4',
// '@modelcontextprotocol/sdk/...') and resolved through the packages' own "exports" maps —
// never through a hardcoded entry filename. Node's own resolver walks up from this file, so
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
//   2. plain Node resolution of the bare specifier from this file
//   3. the same bare specifier resolved from the dsh install root

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
 * Peer dependencies are declared as BOTH `dependencies` and `peerDependencies`, because
 * either location may be what Node finds — a copy installed next to this plugin, or the host
 * dsh install's copy. Whichever tree plain resolution lands on must serve every member of a
 * group below: for the MCP SDK that matters beyond version skew, since its zod-backed
 * schemas are identity-sensitive. So if plain resolution provides one member of a group, all
 * members are re-resolved from that same anchor and cached together; if plain resolution
 * provides none of them, the first anchored tree that provides the whole group serves it.
 */
function resolveEntry(override, specifier) {
  if (override) return override
  const group = CONSISTENCY_GROUPS.find((g) => g.includes(specifier))
  if (!group) return tryResolveFrom(selfPath, specifier) ?? specifier
  if (groupCache.has(specifier)) return groupCache.get(specifier)
  // Anchors in preference order: this plugin's own tree first (that is what a plain bare
  // import would get), then the dsh install, then each npm-global fallback root.
  const anchors = [selfPath, dshInstallAnchor(), ...fallbackNodeModulesRoots().map((root) => join(root, 'noop.js'))].filter(Boolean)
  for (const anchor of anchors) {
    if (resolveGroup(anchor, group)) return groupCache.get(specifier)
  }
  // No tree provided the complete group: fall back to plain resolution per member.
  return tryResolveFrom(selfPath, specifier) ?? specifier
}

/** Specifier groups that must come from one and the same tree (see resolveEntry). */
const CONSISTENCY_GROUPS = [
  ['@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk/client/streamableHttp.js', '@modelcontextprotocol/sdk/types.js', 'zod/v4'],
]

/**
 * Resolve every member of `group` from `anchor`; on a complete hit, cache all members and
 * return true. A partial tree pins nothing — incomplete groups are no better than resolving
 * each specifier independently.
 */
function resolveGroup(anchor, group) {
  const resolved = group.map((member) => tryResolveFrom(anchor, member))
  if (resolved.some((entry) => entry === undefined)) return false
  for (let i = 0; i < group.length; i += 1) if (!groupCache.has(group[i])) groupCache.set(group[i], resolved[i])
  return true
}

const groupCache = new Map()

function resolveDshToolsEntry() {
  return resolveEntry(process.env.DSH_LINEAR_TOOLS, '@deepseek-ai/dsh-tools')
}

// Same resolution chain, but for the schemastery schema lib (used to declare the plugin Config).
function resolveDshSchemasteryEntry() {
  return resolveEntry(process.env.DSH_LINEAR_SCHEMA, '@deepseek-ai/schemastery')
}

// The official MCP SDK — the same package the harness's own
// @deepseek-ai/dsh-mcp-client bridge depends on, so we reuse the installed copy
// rather than inventing a transport. Subpaths come from the SDK's own "exports" map
// instead of a pinned dist path. Resolution is overridable for tests via
// DSH_LINEAR_MCP_SDK (client/index.js), DSH_LINEAR_MCP_SDK_TYPES (types.js),
// and DSH_LINEAR_MCP_SDK_TRANSPORT (client/streamableHttp.js).
// NOTE: in @modelcontextprotocol/sdk 1.x, StreamableHTTPClientTransport lives
// in client/streamableHttp.js, NOT client/index.js (which exports only Client)
// — dsh-mcp-client imports it from the same place.
function resolveMcpSdkClientEntry() {
  return resolveEntry(process.env.DSH_LINEAR_MCP_SDK, '@modelcontextprotocol/sdk/client/index.js')
}

function resolveMcpSdkTransportEntry() {
  return resolveEntry(process.env.DSH_LINEAR_MCP_SDK_TRANSPORT, '@modelcontextprotocol/sdk/client/streamableHttp.js')
}

function resolveMcpSdkTypesEntry() {
  return resolveEntry(process.env.DSH_LINEAR_MCP_SDK_TYPES, '@modelcontextprotocol/sdk/types.js')
}

// The zod the SDK itself resolves to (`import * as z from 'zod/v4'`, hoisted
// next to it in the dsh install), so RawCallToolResultSchema is built with the
// same zod major as the SDK's schemas. DSH_LINEAR_MCP_SDK_ZOD overrides it.
function resolveMcpSdkZodEntry() {
  return resolveEntry(process.env.DSH_LINEAR_MCP_SDK_ZOD, 'zod/v4')
}

const { defineTool, assertSupportedJsonSchema } = await import(resolveDshToolsEntry())
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

function resolveKey(config) {
  const key = config?.apiKey || process.env.LINEAR_API_KEY
  if (!key) throw new Error('Linear API key not configured: set the LINEAR_API_KEY environment variable (or pass `apiKey` in plugin config).')
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

// Resolve a human identifier ("APT-804") or a UUID to a Linear issue UUID.
// IssueFilter has no `identifier` field, so we split the identifier into
// team key + number and look the issue up by those, then return its id.
async function findIssueId(key, id) {
  if (UUID_RE.test(id)) return id
  const m = id.match(/^(.+?)-(\d+)$/)
  if (!m) return null
  const [, teamKey, num] = m
  const data = await gql(key, `
    query($team: String!, $num: Float!) {
      issues(filter: { team: { key: { eq: $team } }, number: { eq: $num } }) {
        nodes { id }
      }
    }
  `, { team: teamKey, num: Number(num) })
  return data.issues.nodes[0]?.id ?? null
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
        'List Linear issues. Optionally filter by team key (e.g. "APT"), state name, or free-text search. Returns up to `limit` most recent issues (default 20, max 50).',
      parameters: {
        team: { type: 'string', description: 'Team key to filter by, e.g. "APT"' },
        state: { type: 'string', description: 'State name to filter by, e.g. "Done", "In Progress"' },
        search: { type: 'string', description: 'Free-text search across title/description' },
        limit: { type: 'number', description: 'Max issues to return (default 20, max 50)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        const filterParts = []
        const vars = {}
        if (args.team) { filterParts.push(`team: { key: { eq: $team } }`); vars.team = args.team }
        if (args.state) { filterParts.push(`state: { name: { eq: $state } }`); vars.state = args.state }
        if (args.search) { filterParts.push(`OR: { title: { containsInsensitive: $search }, description: { containsInsensitive: $search } }`); vars.search = args.search }
        const filter = filterParts.length ? `filter: { ${filterParts.join(', ')} }` : ''
        const usedVars = Object.keys(vars)
        const varDecl = usedVars.length ? `query(${usedVars.map((v) => `$${v}: String`).join(', ')})` : 'query'
        const data = await gql(key(), `
          ${varDecl} {
            issues(first: ${limit}, ${filter}) {
              nodes { ${ISSUE_FIELDS} }
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
        return JSON.stringify({ count: issues.length, issues }, null, 2)
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
      description: 'List comments on a Linear issue (by id or identifier), newest first.',
      parameters: {
        issue: { type: 'string', required: true, description: 'Issue id or identifier' },
        limit: { type: 'number', description: 'Max comments (default 20, max 50)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        const issueId = await findIssueId(key(), args.issue)
        if (!issueId) return JSON.stringify({ error: `Issue not found: ${args.issue}` })
        const data = await gql(key(), `
          query($id: String!) {
            issue: issue(id: $id) {
              id
              comments(first: ${limit}) {
                nodes { ${COMMENT_FIELDS} }
              }
            }
          }
        `, { id: issueId })
        if (!data.issue) return JSON.stringify({ error: `Issue not found: ${args.issue}` })
        return JSON.stringify({
          issue: args.issue,
          count: data.issue.comments.nodes.length,
          comments: data.issue.comments.nodes,
        }, null, 2)
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
      description: 'List all Linear teams (key, name, description).',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute() {
        const data = await gql(key(), `
          {
            teams(first: 100) {
              nodes { ${TEAM_FIELDS} }
            }
          }
        `)
        return JSON.stringify({ count: data.teams.nodes.length, teams: data.teams.nodes }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_state_list',
      description: 'List workflow states for a team (e.g. Todo, In Progress, Done).',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        // Resolve the team to a UUID via the PLURAL `teams` field (the singular
        // `team` field takes only a UUID id), then list that team's states via
        // the top-level `workflowStates` field filtered by team id.
        const teamId = await resolveTeamId(key(), args.team)
        const data = await gql(key(), `
          query($teamId: String!) {
            workflowStates(filter: { team: { id: { eq: $teamId } } }) {
              nodes { ${STATE_FIELDS} }
            }
          }
        `, { teamId })
        return JSON.stringify({ team: args.team, states: data.workflowStates.nodes }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_label_list',
      description: 'List labels for a team.',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const teamId = await resolveTeamId(key(), args.team)
        const data = await gql(key(), `
          query($teamId: String!) {
            issueLabels(filter: { team: { id: { eq: $teamId } } }) {
              nodes { ${LABEL_FIELDS} }
            }
          }
        `, { teamId })
        return JSON.stringify({ team: args.team, labels: data.issueLabels.nodes }, null, 2)
      },
    }),
  )

  register(
    defineTool({
      name: 'linear_project_list',
      description: 'List Linear projects (name, description, state, teams).',
      parameters: {
        limit: { type: 'number', description: 'Max projects (default 20, max 50)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        const data = await gql(key(), `
          {
            projects(first: ${limit}) {
              nodes { ${PROJECT_FIELDS} }
            }
          }
        `)
        return JSON.stringify({ count: data.projects.nodes.length, projects: data.projects.nodes }, null, 2)
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
      description: 'List cycles for a team. Returns up to `limit` most recent cycles (default 20, max 50).',
      parameters: {
        team: { type: 'string', required: true, description: 'Team key, e.g. "APT"' },
        limit: { type: 'number', description: 'Max cycles (default 20, max 50)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        const teamId = await resolveTeamId(key(), args.team)
        const data = await gql(key(), `
          query($teamId: String!) {
            cycles(first: ${limit}, filter: { team: { id: { eq: $teamId } } }) {
              nodes { ${CYCLE_FIELDS} }
            }
          }
        `, { teamId })
        const cycles = data.cycles.nodes.map((c) => ({
          id: c.id,
          number: c.number,
          name: c.name,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          completedAt: c.completedAt,
        }))
        return JSON.stringify({ team: args.team, count: cycles.length, cycles }, null, 2)
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
      description: 'List users in the workspace. Returns up to `limit` users (default 20, max 50).',
      parameters: {
        limit: { type: 'number', description: 'Max users (default 20, max 50)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a, v) => [{ type: 'text', text: v }],
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 50)
        const data = await gql(key(), `
          {
            users(first: ${limit}) {
              nodes { ${USER_FIELDS} }
            }
          }
        `)
        return JSON.stringify({ count: data.users.nodes.length, users: data.users.nodes }, null, 2)
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
}

// ---------------------------------------------------------------------------
// MCP bridge — parity with Linear's hosted MCP server
// ---------------------------------------------------------------------------
//
// Linear's hosted MCP server (https://mcp.linear.app/mcp) speaks the official
// Model Context Protocol over Streamable HTTP. This bridge:
//   - connects with the installed @modelcontextprotocol/sdk Client +
//     StreamableHTTPClientTransport (the same transport dsh-mcp-client uses),
//   - authenticates with `Authorization: Bearer <token>` — Linear's hosted MCP
//     endpoint expects the Bearer scheme, unlike the raw-value GraphQL header;
//     the token is only ever placed in request headers, never in a tool name,
//     description, schema, or log line,
//   - DISCOVERS the server's tools at connect time with `tools/list` (paginated)
//     and registers one harness tool per discovered MCP tool, so no Linear MCP
//     API is hand-invented here,
//   - forwards every call with `tools/call` using the RAW wire name (never the
//     public name), mirroring dsh-mcp-client's naming contract:
//       public name = `linear_mcp_<rawName>` when it fits the DeepSeek
//       function-name contract (≤64 chars, [A-Za-z0-9_-]), otherwise a lossy
//       normalization plus a 12-hex SHA-256 hash of the identity so distinct
//       MCP identities never collapse onto one public name. Names are a pure
//       function of the discovered raw name → stable across reconnects,
//   - on `notifications/tools/list_changed` re-discovers and atomically swaps
//     the registration generation (fetch fully first; only then dispose the old
//     generation and register the new one),
//   - on connection loss rebuilds the whole generation with bounded exponential
//     backoff, and unregisters when reconnect is disabled or exhausted.
//
// The bridge is fail-soft: without an MCP token (LINEAR_MCP_TOKEN / config),
// with no loadable MCP SDK, or in a minimal ctx that lacks `ctx.effect`, the
// GraphQL suite still registers and the bridge simply stays off.

const DEFAULT_MCP_URL = 'https://mcp.linear.app/mcp'
const MCP_NAME_PREFIX = 'linear_mcp_'
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
/** Defaults shared by the Reconnect schema and resolveReconnectPolicy. */
const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
})
/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 60000

// Resolve the MCP SDK lazily but once, so a missing/unreachable SDK never
// breaks the GraphQL tools that share this module.
// The SDK (1.30.0, same copy dsh-mcp-client uses) has no RawCallToolResultSchema
// export; mirror dsh-mcp-client's raw record schema — `z.record(z.string(),
// z.unknown())` from the same zod the SDK resolves to — so the bridge owns
// result validation instead of the SDK pre-validating a different contract.
// DSH_LINEAR_MCP_SDK_ZOD overrides the zod URL for offline tests.
let mcpSdkPromise
function loadMcpSdk() {
  mcpSdkPromise ??= (async () => {
    const sdk = await import(resolveMcpSdkClientEntry())
    const transport = await import(resolveMcpSdkTransportEntry())
    const types = await import(resolveMcpSdkTypesEntry())
    const zod = await import(resolveMcpSdkZodEntry())
    return {
      Client: sdk.Client,
      StreamableHTTPClientTransport: transport.StreamableHTTPClientTransport,
      ListToolsResultSchema: types.ListToolsResultSchema,
      ToolListChangedNotificationSchema: types.ToolListChangedNotificationSchema,
      // Same raw record schema dsh-mcp-client builds (zod v4 `z` namespace from 'zod/v4').
      RawCallToolResultSchema: zod.z.record(zod.z.string(), zod.z.unknown()),
    }
  })()
  return mcpSdkPromise
}

// Deterministic public name for one discovered MCP tool (see naming contract above).
// The 64-char function-name limit is measured against the PUBLIC name. Two defects
// this bridge's own tests caught:
//   - the old `normalized === joined` guard threw away a perfectly valid readable
//     name whenever normalization changed anything ("get.issues/v2" → hashed), and
//   - the truncation was taken from the RAW name, silently dropping the
//     linear_mcp_ namespace prefix that keeps these tools distinct from every
//     other plugin's. Truncate the prefixed name instead.
function publicToolName(rawName) {
  const joined = `${MCP_NAME_PREFIX}${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`linear\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

// Keep a supported advertised output schema; unsupported MCP vocabulary falls
// back to unconstrained (annotation-only), exactly like dsh-mcp-client.
function supportedOutputSchema(candidate) {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

// Canonical output contract for one proxied MCP tool.
function createMcpOutput(rawName, structuredSchema) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: extractText(value.content, rawName) }]
    },
  }
}

// Extract text from an MCP content array into one string (network trust
// boundary: spec-required fields are guarded with fallbacks).
function extractText(mcpContent, toolName) {
  const parts = []
  for (const value of Array.isArray(mcpContent) ? mcpContent : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      parts.push('[unsupported MCP content block: expected an object]')
      continue
    }
    switch (value.type) {
      case 'text':
        if (value.text !== undefined) parts.push(value.text)
        break
      case 'image':
        parts.push(`[image result unsupported; raw image data remains available to programmatic callers]`)
        break
      case 'audio':
        parts.push(`[audio result unsupported: ${value.mimeType ?? 'unknown media type'}]`)
        break
      case 'resource_link':
        if (value.name === undefined || value.uri === undefined) parts.push('[resource link unavailable: the MCP block is missing its name or URI]')
        else parts.push(`Resource link: ${value.name} (${value.uri})`)
        break
      case 'resource':
        parts.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]')
        break
      default:
        parts.push(`[unsupported MCP content type: ${value.type}]`)
    }
  }
  return parts.length > 0 ? parts.join('\n') : `(${toolName} returned no model-visible content)`
}

// Credential-leak guard for diagnostics: strip anything that looks like a
// bearer/API token before an error message reaches a log line or the model.
// The li_ shape must match the WHOLE token run: Linear keys are
// "li_api_<base64-ish body>" with '_' inside the body, so the old \b-anchored
// /\bli_[A-Za-z0-9]+\b/ stopped at the first inner underscore and leaked the
// entire secret body past the guard.
const TOKEN_SHAPES = [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, /\bli_[A-Za-z0-9_]+/g, /\bsk-[A-Za-z0-9]+/g]
function redactSecrets(text) {
  let out = String(text)
  for (const re of TOKEN_SHAPES) out = out.replace(re, '[redacted]')
  return out
}

/**
 * Validate raw reconnect config and apply defaults. Re-judges every bound
 * because programmatic construction may bypass Schemastery normalization.
 */
function resolveReconnectPolicy(config, path) {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) throw new Error(`${path}.initialDelayMs must be a positive finite number`)
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) throw new Error(`${path}.maxDelayMs must be a positive finite number`)
  if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`${path}.maxAttempts must be a positive integer`)
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/**
 * One supervised MCP connection: connect → discover → register; re-discover on
 * list_changed; rebuild the generation on connection loss with bounded backoff.
 *
 * Registration lifecycle fit (verified against cordis 4.0.2): a plugin `apply`
 * may be async — the fiber awaits it (`_execute`/`_reload`) and collects effect
 * disposers registered during it — so discovery at apply time is compatible.
 * Later re-syncs run OUTSIDE apply: every registration is owned by an explicit
 * `ctx.effect()` whose disposer unregisters that generation's tools, and the
 * reconnect timer is `unref()`ed so a pending retry never keeps the process alive.
 */
function startMcpConnection(ctx, config) {
  const label = 'linear-mcp'
  const policy = resolveReconnectPolicy(config.reconnect, 'linear mcp: reconnect')
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS

  let disposed = false
  /** The live generation's Client (undefined while down/backing off). */
  let client
  /** Live registrations owned by the current generation. */
  let disposers = new Map()
  let reconnectTimer
  /** Consecutive failed connection attempts within the current outage. */
  let failedAttempts = 0
  /** When the current generation finished connect + initial discovery. */
  let connectedAt
  /** The real error from the first attempt, for apply-time diagnostics. */
  let firstAttemptError
  /** Serializes every discovery swap so two can never interleave. */
  let syncChain = Promise.resolve()

  const isCurrent = (generation) => !disposed && client === generation

  // One effect slot owns ALL registrations of the current generation. It is
  // armed exactly once, during apply (so it belongs to the plugin fiber), and
  // always unregisters whatever is live at teardown — never a stale set.
  // (Cordis `_execute` rejects a *returned* function as "Invalid effect", so
  // the disposer is collected by returning an iterable of disposers.)
  ctx.effect(() => [
    () => {
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  ], 'linear.mcp.tools')

  /** Fetch the complete next generation, then atomically swap registrations. */
  async function syncTools(generation) {
    const sdk = await loadMcpSdk()
    const definitions = new Map()
    const seenCursors = new Set()
    let cursor
    do {
      // Uncached paginated tools/list (same idiom as dsh-mcp-client): a raw
      // request keeps the SDK's per-page schema cache from merging pages.
      const response = await generation.request(
        { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
        sdk.ListToolsResultSchema,
      )
      for (const tool of response.tools) {
        const publicName = publicToolName(tool.name)
        if (definitions.has(publicName)) {
          throw new Error(`${label}: server listed tool "${tool.name}" more than once — invalid tool list`)
        }
        definitions.set(publicName, createMcpDefinition(generation, sdk, publicName, tool, config))
      }
      cursor = response.nextCursor
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error(`${label}: server repeated a tools/list continuation cursor — invalid tool list`)
        seenCursors.add(cursor)
      }
    } while (cursor)
    // Fetch phase succeeded — only now swap: dispose the old generation, then
    // register the new one. A registration conflict rolls the partial back.
    for (const dispose of disposers.values()) dispose()
    const next = new Map()
    try {
      for (const [publicName, definition] of definitions) next.set(publicName, ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of next.values()) dispose()
      disposers = new Map()
      ctx.logger.error(`${label}: tool registration failed, no tools registered: ${String(error)}`)
      throw error
    }
    disposers = next
    return next.size
  }

  function enqueueSync(generation) {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      await syncTools(generation)
    })
    syncChain = run.catch(() => {})
    return run
  }

  /** One disconnect decision per generation (idempotent under racing close/error). */
  function generationDown(generation) {
    if (!isCurrent(generation)) return
    client = undefined
    scheduleReconnect()
  }

  function scheduleReconnect() {
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      ctx.logger.error(`${label}: ${lostEstablishedConnection ? 'connection lost and reconnect is disabled' : 'connection failed and reconnect is disabled'} — Linear MCP tools are unavailable until the plugin reloads or the Host restarts`)
      return
    }
    // A connection that stayed up past maxDelayMs closes the outage, so a
    // crash-loop still exhausts the cap instead of restarting forever.
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      })
      ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — Linear MCP tools unregistered; reload the plugin or restart the Host to reconnect`)
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    ctx.logger.warn(`${label}: ${lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connectGeneration(false)
    }, delayMs)
    reconnectTimer.unref()
  }

  /** One connection attempt. Never rejects; every failure funnels through generationDown. */
  async function connectGeneration(startup) {
    let sdk
    try {
      sdk = await loadMcpSdk()
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      ctx.logger.error(`${label}: the MCP SDK could not be loaded — Linear MCP tools are unavailable: ${String(error)}`)
      return
    }
    const generation = new sdk.Client({ name: 'dsh-linear-mcp-bridge', version: '0.1.0' }, { capabilities: {} })
    client = generation
    // A close observed DURING the attempt is handled by the attempt's own
    // settle path; only a post-settle close triggers the reconnect decision.
    let attemptSettled = false
    generation.onclose = () => {
      if (attemptSettled && isCurrent(generation)) generationDown(generation)
    }
    generation.onerror = (error) => {
      // Transport-level errors are logged; a dead transport also fires onclose.
      ctx.logger.warn(`${label}: transport error: ${redactSecrets(error?.message ?? error)}`)
    }
    generation.setNotificationHandler(sdk.ToolListChangedNotificationSchema, async () => {
      if (!isCurrent(generation)) return
      ctx.logger.info(`${label}: tool list changed, re-syncing`)
      try {
        await enqueueSync(generation)
      } catch (error) {
        if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
      }
    })
    // Credentials live ONLY in this header map, rebuilt per generation.
    const headers = { Authorization: `Bearer ${config.token}` }
    try {
      await generation.connect(new sdk.StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } }))
      if (generation.transport === undefined) {
        // The transport closed itself during connect(): settle the attempt and
        // let the reconnect scheduler take over.
        attemptSettled = true
        if (isCurrent(generation)) generationDown(generation)
        return
      }
      if (startup) {
        // Startup registration failure is fatal to apply so the operator sees it.
        const count = await syncTools(generation)
        ctx.logger.info(`${label}: connected to ${config.url}, registered ${count} Linear MCP tools`)
      } else {
        await enqueueSync(generation)
        if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
      }
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${authHint(error)}`)
      try {
        await generation.close()
      } catch {}
      attemptSettled = true
      if (!isCurrent(generation)) return
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
  }

  // Surface an actionable hint for auth failures without echoing any secret.
  function authHint(error) {
    const text = String(error?.message ?? error)
    if (/401|Unauthorized/i.test(text)) return `${text} — check that the Linear MCP token (LINEAR_MCP_TOKEN / config mcp.token) is valid for ${config.url}`
    return text
  }

  const settling = connectGeneration(true)
  ctx.effect(() => [
    () => {
      disposed = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const current = client
      client = undefined
      return async () => {
        if (current !== undefined) {
          try {
            await current.close()
          } catch {}
        }
        await settling
        await syncChain
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      }
    },
  ], 'linear.mcp.connection')

  return {
    /** Settles after the startup attempt; carries its error without throwing. */
    ready: settling.then(() => firstAttemptError),
  }
}

/** Build one harness tool definition for a discovered MCP tool. */
function createMcpDefinition(client, sdk, publicName, tool, config) {
  const rawName = tool.name
  return {
    name: publicName,
    description: tool.description ?? '',
    // Pass the DISCOVERED input schema straight through; this plugin never
    // hand-models Linear's MCP API surface.
    parameters: tool.inputSchema ?? {},
    output: createMcpOutput(rawName, supportedOutputSchema(tool.outputSchema)),
    timeoutMs: config.toolCallTimeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    async execute(args, exec) {
      const result = await client.request(
        { method: 'tools/call', params: { name: rawName, arguments: typeof args === 'object' && args !== null ? args : {} } },
        // Raw record schema (same as dsh-mcp-client): the bridge owns result
        // validation instead of the SDK pre-validating a different contract.
        sdk.RawCallToolResultSchema ?? { parse: (v) => v },
        { signal: exec.signal, timeout: config.toolCallTimeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS },
      )
      if (result.isError === true) throw new Error(redactSecrets(extractText(result.content, rawName)))
      return {
        content: Array.isArray(result.content) ? result.content : [],
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin surface
// ---------------------------------------------------------------------------

/**
 * Plugin config:
 *   apiKey: Linear personal API key (li_api_...) for the GraphQL tools.
 *           Falls back to the LINEAR_API_KEY environment variable when unset.
 *   mcp:    optional MCP-bridge config (Linear hosted MCP server parity):
 *             token  — bearer token; falls back to LINEAR_MCP_TOKEN, then to
 *                      the same key resolution as `apiKey` (config apiKey or
 *                      LINEAR_API_KEY). The value is used ONLY in the
 *                      Authorization header of requests to `url`.
 *             url    — Streamable HTTP endpoint (default https://mcp.linear.app/mcp).
 *             toolCallTimeoutMs / reconnect — call timeout and bounded backoff.
 *
 * The getter above mirrors resolveKey's precedence: a config.apiKey passed in the
 * patch row wins over the env var. The getter itself has no access to the
 * config object (it's a module-level singleton), so it only reports the env
 * var; the authoritative resolution happens in resolveKey which checks
 * `config?.apiKey` first.
 */
// Cordis 0.1.5 validates a plugin's `Config` as a Standard Schema (it calls
// Config["~standard"].validate(...)). The real API key still comes from the
// LINEAR_API_KEY env var (see resolveKey); this schema only needs to accept an
// optional `apiKey` string so a patch row may also supply one. `.default('')`
// makes a missing field valid; the empty value is ignored by resolveKey, which
// prefers config.apiKey only when it is non-empty and otherwise falls back to env.
const Reconnect = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(2147483647).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(2147483647).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

const McpConfig = z.object({
  token: z.string().default(''),
  url: z.string().default(DEFAULT_MCP_URL),
  toolCallTimeoutMs: z.number().min(1).default(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS),
  reconnect: Reconnect,
})

const Config = z.object({
  apiKey: z.string().default(''),
  mcp: McpConfig,
})

/**
 * Resolve the MCP bearer token without ever printing it. Precedence:
 * config.mcp.token → LINEAR_MCP_TOKEN → the GraphQL key resolution chain.
 */
function resolveMcpToken(config) {
  const token = config?.mcp?.token || process.env.LINEAR_MCP_TOKEN || config?.apiKey || process.env.LINEAR_API_KEY
  if (!token) throw new Error('Linear MCP token not configured: set the LINEAR_MCP_TOKEN environment variable (or pass `mcp.token` / `apiKey` in plugin config).')
  return token
}

// The bridge is opt-in and fail-soft: a missing token or an unreachable MCP
// server must never take down the GraphQL tool suite that shares this plugin.
// LINEAR_MCP_DISABLED=1 turns it off; otherwise it starts only when an MCP
// token is configured AND the host ctx supports effect-scoped teardown
// (ctx.effect) — a bare test ctx without lifecycle support keeps the bridge off.
const MCP_BRIDGE_ENABLED = process.env.LINEAR_MCP_DISABLED !== '1'

async function apply(ctx, config) {
  registerLinearTools(ctx, config)
  if (!MCP_BRIDGE_ENABLED || typeof ctx.effect !== 'function') return
  let mcpConfig
  try {
    mcpConfig = {
      token: resolveMcpToken(config),
      url: config?.mcp?.url || DEFAULT_MCP_URL,
      toolCallTimeoutMs: config?.mcp?.toolCallTimeoutMs,
      reconnect: config?.mcp?.reconnect,
    }
  } catch (err) {
    ctx.logger.warn(`linear-mcp: bridge disabled — ${err?.message ?? err}`)
    return
  }
  const connection = startMcpConnection(ctx, mcpConfig)
  // Startup attempt settles inside apply (cordis awaits an async apply), so a
  // failure here is reported once, clearly, and does not throw the fiber down.
  await connection.ready
}

// The MCP-bridge internals are exported alongside the plugin surface so the
// mock-based bridge tests (test-mcp-bridge.js) can exercise discovery, naming,
// auth, forwarding and disposal in isolation. Cordis's namespace unwrap keys off
// { name, inject, apply }, so extra named exports are inert for the loader.
export {
  Config,
  apply,
  inject,
  name,
  // MCP bridge internals (test-visible; no behaviour change)
  createMcpDefinition,
  createMcpOutput,
  extractText,
  publicToolName,
  redactSecrets,
  resolveMcpToken,
  resolveReconnectPolicy,
  startMcpConnection,
  supportedOutputSchema,
}
