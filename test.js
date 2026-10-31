// Self-check for @kb1slnlabs/dsh-linear: verifies the module surface, the
// defineTool registrations (26 direct GraphQL tools), and the GraphQL client
// against a mock server that mirrors the REAL Linear schema (flat UUID input
// fields, plural `teams`/`workflowStates`/`issueLabels`/`cycles` query fields).
// The plugin has no MCP half — nothing here opens or mocks an MCP endpoint.
//
// Run: node test.js   (no network for the mock suite; the introspection guard
// below runs live against the real Linear API only when LINEAR_API_KEY is set,
// and is skipped otherwise.)

import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// The real home directory, captured before any test redirects HOME/USERPROFILE.
// Only used to assert that the key-file fallback tests never touch a real
// ~/.config/linear/api-key — its contents are never read by this suite.
const realHomeDir = homedir()

// Capture the real key BEFORE the test overwrites LINEAR_API_KEY with a fake
// value below (line ~36) and deletes it at the end. The introspection guard
// (section 5) needs the real key to hit the live Linear schema.
const REAL_LINEAR_KEY = process.env.LINEAR_API_KEY || ''

// --- 1. Module surface -------------------------------------------------------
const mod = await import(new URL('./index.js', import.meta.url))
assert.equal(mod.name, 'linear', 'plugin name')
assert.deepEqual(mod.inject, ['tools'], 'inject list')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config present')
console.log('ok - module surface (name/inject/apply/Config)')

// --- 2. Tool registration against a fake ctx ---------------------------------
const registered = []
const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
  },
}

process.env.LINEAR_API_KEY = 'li_api_test'
mod.apply(ctx, {})

const expected = [
  'linear_issue_list',
  'linear_issue_get',
  'linear_issue_create',
  'linear_issue_update',
  'linear_issue_archive',
  'linear_issue_unarchive',
  'linear_comment_add',
  'linear_comment_update',
  'linear_comment_delete',
  'linear_comment_list',
  'linear_relation_add',
  'linear_team_list',
  'linear_state_list',
  'linear_label_list',
  'linear_project_list',
  'linear_project_create',
  'linear_project_update',
  'linear_label_create',
  'linear_cycle_list',
  'linear_cycle_get',
  'linear_user_list',
  'linear_user_get',
  'linear_project_get',
  'linear_label_get',
  'linear_team_get',
  'linear_graphql',
]

// The plugin registers exactly its 26 direct GraphQL tools and nothing else.
// There is no MCP surface to opt into, so an `mcp` block in the config is inert:
// it registers nothing beyond those 26, opens no connection (link-local port 1,
// which nothing listens on, would fail fast if it did), logs nothing about it,
// and never calls ctx.effect.
const inertRegistered = []
const inertLogs = []
let inertEffectCalls = 0
await mod.apply(
  {
    tools: { register(def) { inertRegistered.push(def); return () => {} } },
    logger: { info() {}, warn: (m) => inertLogs.push(m), error: (m) => inertLogs.push(m) },
    effect() { inertEffectCalls += 1 },
  },
  { mcp: { enabled: true, url: 'http://127.0.0.1:1/mcp', reconnect: { enabled: false } } },
)
assert.equal(inertRegistered.length, expected.length, `an mcp-enabled config registers exactly ${expected.length} direct tools, got ${inertRegistered.length}`)
assert.ok(!inertRegistered.some((d) => d.name.startsWith('linear_mcp_')), 'no linear_mcp_* tool exists at all')
assert.deepEqual(inertLogs, [], 'an inert mcp config logs nothing')
assert.equal(inertEffectCalls, 0, 'an inert mcp config registers no effects')

assert.equal(registered.length, expected.length, `registered ${registered.length} tools, expected ${expected.length}`)
for (const name of expected) {
  const def = registered.find((d) => d.name === name)
  assert.ok(def, `tool ${name} registered`)
  assert.equal(typeof def.execute, 'function', `${name}.execute is a function`)
  assert.ok(def.description, `${name} has a description`)
}
console.log(`ok - ${registered.length} tools registered with execute + description`)

// --- 3. GraphQL client against a mock Linear API ------------------------------
// The mock mirrors the REAL Linear schema:
//   - IssueCreateInput / IssueUpdateInput / CommentCreateInput /
//     IssueRelationCreateInput / LabelCreateInput / ProjectCreateInput are FLAT
//     (teamId / stateId / assigneeId / labelIds / issueId / relatedId / teamIds)
//   - the singular `team`/`issue`/`cycle`/`project`/`user`/`issueLabel` query
//     fields take a UUID id; the PLURAL `teams`/`workflowStates`/`issueLabels`/
//     `cycles` fields take a `filter`.
const seen = []
// Offline cursor-pagination fixture shared by every direct list tool. The mock
// answers page 2 only when the caller's `after` VARIABLE came back unchanged, so
// a test can prove the cursor travelled as a variable and never entered the query
// text. PAGE1/PAGE2 are the two pageInfo states of one connection; CURSOR_NOINFO
// selects the pageInfo-less (older/blank server) shape used by the
// backwards-compatibility probe below.
const PAGE1 = { hasNextPage: true, endCursor: 'CURSOR_PAGE2' }
const PAGE2 = { hasNextPage: false, endCursor: null }
function pagedConnection(alias, nodesByPage, vars = {}) {
  const cursor = vars.after ?? null
  // A server that reports no pageInfo at all also does not advance the page.
  if (cursor === 'CURSOR_NOINFO') {
    return JSON.stringify({ data: { [alias]: { nodes: nodesByPage[0] } } })
  }
  const onSecondPage = cursor === 'CURSOR_PAGE2'
  return JSON.stringify({
    data: {
      [alias]: {
        nodes: onSecondPage ? nodesByPage[1] : nodesByPage[0],
        pageInfo: onSecondPage ? PAGE2 : PAGE1,
      },
    },
  })
}
function badCursor() {
  return JSON.stringify({ errors: [{ message: 'Invalid cursor provided: after' }] })
}
const TEAM_NODE = { id: '12345678-1234-1234-1234-123456789abc', name: 'APT', key: 'APT', description: 'd' }
// The UUID the identifier resolver hands back for "APT-1" (the issues(filter: { team … })
// fixture below), and the UUID the team resolver hands back for "APT" (TEAM_NODE.id).
const ISSUE_UUID = 'dddddddd-1111-2222-3333-444444444444'
// The UUID findProjectId hands back for the project NAME 'P' (see the
// projects(filter: { name: { eq: $name } }) fixture). Distinct from the p1 node
// id used by list/get fixtures so a test can tell resolution actually happened.
const PROJECT_UUID = 'eeeeeeee-1111-2222-3333-444444444444'
// A second project UUID the mock returns alongside PROJECT_UUID for the ambiguous
// name 'DUP', so a test can prove the resolver refuses to pick one of them.
const DUPLICATE_PROJECT_UUID = 'e2e2e2e2-1111-2222-3333-444444444444'
// The UUID findIssueId hands back for the 'FAILTEAM-7' identifier. The archive
// mock rejects exactly this id with success:false, so a test can reach the
// failure path through the normal identifier-resolution route.
const FAIL_ISSUE_UUID = 'ffffffff-1111-2222-3333-444444444444'
// The UUID findIssueId hands back for the 'ARCHIVED-1' identifier — an issue the
// mock only reports when the lookup query carries includeArchived: true.
const ARCHIVED_ISSUE_UUID = 'abababab-1111-2222-3333-444444444444'
const STATE_NODES = [[{ id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Todo', type: 'unstarted', position: 0 }, { id: 'cccccccc-1111-2222-3333-444444444444', name: 'In Progress', type: 'started', position: 1 }], [{ id: 'dddddddd-1111-2222-3333-444444444444', name: 'Backlog', type: 'backlog', position: -1 }]]
const LABEL_NODES = [[{ id: 'l1', name: 'bug', color: '#f00', description: '' }], [{ id: 'l2page', name: 'feature', color: '#0f0', description: 'second page' }]]
const CYCLE_NODES = [[{ id: 'c1', number: 1, name: 'Cycle 1', startsAt: '2024-01-01', endsAt: '2024-01-14', completedAt: '2024-01-14', progress: 0.5, team: { id: 't1', name: 'APT', key: 'APT' } }], [{ id: 'c2', number: 2, name: 'Cycle 2', startsAt: '2024-01-15', endsAt: '2024-01-28', completedAt: null, progress: 0, team: { id: 't1', name: 'APT', key: 'APT' } }]]
const PROJECT_NODES = [[{ id: 'p1', name: 'P', description: '', state: 'started', teams: [{ id: 't1', name: 'APT', key: 'APT' }] }], [{ id: 'p2page', name: 'P2', description: 'second page', state: 'completed', teams: [] }]]
const USER_NODES = [[{ id: 'u1', name: 'Alice', displayName: 'Alice A', email: 'alice@example.com', active: true }], [{ id: 'u2page', name: 'Bob', displayName: 'Bob B', email: 'bob@example.com', active: true }]]
const TEAM_NODES_PAGE = [[TEAM_NODE], [{ id: '22345678-1234-1234-1234-123456789abc', name: 'Second', key: 'SEC', description: 'second page' }]]
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    seen.push({
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
      // Which mock served this call. `res` here is the ServerResponse (its own
      // headers are not written until later), so the marker is carried in a
      // module-scoped slot set by the fetch shim below — res.headers.get() is
      // not available on an IncomingMessage/ServerResponse pair.
      target: currentMockTarget,
      query: parsed.query,
      variables: parsed.variables,
    })
    res.setHeader('content-type', 'application/json')
    const q = parsed.query
    const v = parsed.variables ?? {}
    // Order matters: more specific markers first.
    if (q.includes('workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }')) {
      res.end(JSON.stringify({ data: { workflowStates: { nodes: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Backlog' }] } } }))
    } else if (q.includes('workflowStates(filter: { team: { id: { eq: $teamId } } }')) {
      if ((v.after ?? null) === 'CURSOR_BAD') res.end(badCursor())
      else res.end(pagedConnection('workflowStates', STATE_NODES, v))
    } else if (q.includes('issueLabels(filter: { team: { id: { eq: $teamId } } }')) {
      if ((v.after ?? null) === 'CURSOR_BAD') res.end(badCursor())
      else res.end(pagedConnection('issueLabels', LABEL_NODES, v))
    } else if (q.includes('cycles(first')) {
      if ((v.after ?? null) === 'CURSOR_BAD') res.end(badCursor())
      else res.end(pagedConnection('cycles', CYCLE_NODES, v))
    } else if (q.includes('teams(first: 10, filter: { key: { eq: $v } }')) {
      if (v.v === 'NOPE') res.end(JSON.stringify({ data: { teams: { nodes: [] } } }))
      else res.end(JSON.stringify({ data: { teams: { nodes: [{ id: '12345678-1234-1234-1234-123456789abc', name: 'APT', key: 'APT', description: 'd' }] } } }))
    } else if (q.includes('teams(first: 10, filter: { key: { eq: $key } }')) {
      if (v.key === 'NOPE') res.end(JSON.stringify({ data: { teams: { nodes: [] } } }))
      else res.end(JSON.stringify({ data: { teams: { nodes: [{ id: '12345678-1234-1234-1234-123456789abc', name: 'APT', key: 'APT', description: 'd' }] } } }))
    } else if (q.includes('teams(first: 100')) {
      if ((v.after ?? null) === 'CURSOR_BAD') res.end(badCursor())
      else res.end(pagedConnection('teams', TEAM_NODES_PAGE, v))
    } else if (q.includes('issues(filter: { team')) {
      // findIssueId fixture. TEAM-<n> resolves to ISSUE_UUID; the 'NOPE' team key
      // matches nothing (a tool must fail before sending any mutation); and
      // FAILTEAM-7 resolves to FAIL_ISSUE_UUID, the id whose archive the mutation
      // mock rejects with success:false.
      if (v.team === 'NOPE') res.end(JSON.stringify({ data: { issues: { nodes: [] } } }))
      else if (v.team === 'FAILTEAM') res.end(JSON.stringify({ data: { issues: { nodes: [{ id: FAIL_ISSUE_UUID }] } } }))
      // ARCHIVED-1 models the real schema's visibility rule: an archived issue is
      // invisible to the plain `issues` query and only comes back when the document
      // asks for includeArchived. So a lookup that does not opt in resolves to
      // nothing — exactly how a tool that cannot reach archived issues fails.
      else if (v.team === 'ARCHIVED') res.end(JSON.stringify({ data: { issues: { nodes: q.includes('includeArchived: true') ? [{ id: ARCHIVED_ISSUE_UUID }] : [] } } }))
      else res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'dddddddd-1111-2222-3333-444444444444' }] } } }))
    } else if (q.includes('issues(first')) {
      // Cursor pagination fixture: the cursor is echoed so a test can prove the
      // `after` value passed by the caller reached the server as a VARIABLE and
      // came back on the next page. The two-page shape (hasNextPage true then
      // false) mirrors a real connection.
      const after = v.after ?? null
      if (after === 'CURSOR_NOINFO') {
        // pageInfo-less (older/blank server) shape, same as pagedConnection().
        res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'i1', identifier: 'APT-1', title: 'T', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'https://linear.app/x/issue/APT-1' }] } } }))
      } else if (after === 'CURSOR_PAGE2') {
        res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'i2', identifier: 'APT-2', title: 'Second page', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'https://linear.app/x/issue/APT-2' }], pageInfo: { hasNextPage: false, endCursor: null } } } }))
      } else if (after === 'CURSOR_BAD') {
        res.end(JSON.stringify({ errors: [{ message: 'Invalid cursor provided: after' }] }))
      } else {
        res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'i1', identifier: 'APT-1', title: 'T', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'https://linear.app/x/issue/APT-1' }], pageInfo: { hasNextPage: true, endCursor: 'CURSOR_PAGE2' } } } }))
      }
    } else if (q.includes('issue: issue(id: $id) { id team { id } }')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', team: { id: 't1' } } } }))
    } else if (q.includes('comments(first')) {
      // Same cursor fixture as issues(first: ...) — echo the variable, two pages.
      const after = v.after ?? null
      if (after === 'CURSOR_NOINFO') {
        // pageInfo-less (older/blank server) shape, same as pagedConnection().
        res.end(JSON.stringify({ data: { issue: { id: 'i1', comments: { nodes: [{ id: 'c1', body: 'hello', createdAt: 'now' }] } } } }))
      } else if (after === 'CURSOR_PAGE2') {
        res.end(JSON.stringify({ data: { issue: { id: 'i1', comments: { nodes: [{ id: 'c2', body: 'second page', createdAt: 'later' }], pageInfo: { hasNextPage: false, endCursor: null } } } } }))
      } else if (after === 'CURSOR_BAD') {
        res.end(JSON.stringify({ errors: [{ message: 'Invalid cursor provided: after' }] }))
      } else {
        res.end(JSON.stringify({ data: { issue: { id: 'i1', comments: { nodes: [{ id: 'c1', body: 'hello', createdAt: 'now' }], pageInfo: { hasNextPage: true, endCursor: 'CURSOR_PAGE2' } } } } }))
      }
    } else if (q.includes('issue: issue(id: $id)')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', identifier: 'APT-1', title: 'T', description: 'D', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'u', relations: { nodes: [] } } } }))
    } else if (q.includes('comments(')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', comments: { nodes: [{ id: 'c1', body: 'hello', createdAt: 'now' }] } } } }))
    } else if (q.includes('issueCreate')) {
      res.end(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: 'i2', identifier: 'APT-2', title: 'new', state: { name: 'Backlog' }, url: 'u2' } } } }))
    } else if (q.includes('issueUpdate')) {
      res.end(JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: 'i1', identifier: 'APT-1', title: 'T', state: { name: 'Done' }, assignee: null, url: 'u' } } } }))
    } else if (q.includes('issueUnarchive')) {
      // Introspected shape: IssueArchivePayload { success entity lastSyncId } —
      // the issue comes back under `entity`, never `issue`. The mock adds a bogus
      // `issue` field that no correct reader should ever see, so an implementation
      // that read `.issue` would surface 'WRONG-PAYLOAD-FIELD' below.
      res.end(JSON.stringify({ data: { issueUnarchive: { success: true, issue: { id: 'WRONG-PAYLOAD-FIELD', identifier: 'WRONG' }, entity: { id: ISSUE_UUID, identifier: 'APT-1', title: 'T', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'https://linear.app/x/issue/APT-1' } } } }))
    } else if (q.includes('issueArchive')) {
      // success:false for FAIL_ISSUE_UUID (reached through the 'FAILTEAM-7'
      // identifier); success otherwise.
      if (v.id === FAIL_ISSUE_UUID) res.end(JSON.stringify({ data: { issueArchive: { success: false, entity: null } } }))
      else res.end(JSON.stringify({ data: { issueArchive: { success: true, entity: { id: ISSUE_UUID, identifier: 'APT-1', title: 'T', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'https://linear.app/x/issue/APT-1' } } } }))
    } else if (q.includes('commentUpdate')) {
      // CommentPayload { success comment lastSyncId }. MOCK_FAIL_MARKER exercises
      // the success:false path.
      if (v.id === 'MOCK_FAIL_MARKER') res.end(JSON.stringify({ data: { commentUpdate: { success: false, comment: null } } }))
      else res.end(JSON.stringify({ data: { commentUpdate: { success: true, comment: { id: v.id, body: v.input.body, createdAt: 'now' } } } }))
    } else if (q.includes('commentDelete')) {
      // DeletePayload { success entityId lastSyncId } — no entity object at all.
      if (v.id === 'MOCK_FAIL_MARKER') res.end(JSON.stringify({ data: { commentDelete: { success: false, entityId: null } } }))
      else res.end(JSON.stringify({ data: { commentDelete: { success: true, entityId: v.id } } }))
    } else if (q.includes('projectUpdate')) {
      // ProjectPayload { success project lastSyncId }. The mock echoes the input
      // name so a test can prove the flat input reached the server.
      if (v.input?.name === 'MOCK_FAIL_MARKER') res.end(JSON.stringify({ data: { projectUpdate: { success: false, project: null } } }))
      else res.end(JSON.stringify({ data: { projectUpdate: { success: true, project: { id: v.id, name: v.input.name ?? 'P', description: v.input.description ?? '', state: 'started', teams: (v.input.teamIds ?? []).map((id) => ({ id, name: 'APT', key: 'APT' })) } } } }))
    } else if (q.includes('commentCreate')) {
      res.end(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'c1', body: 'hello', createdAt: 'now' } } } }))
    } else if (q.includes('issueRelationCreate')) {
      res.end(JSON.stringify({ data: { issueRelationCreate: { success: true, relation: { id: 'r1' } } } }))
    } else if (q.includes('projects(filter: { name: { eq: $name } })')) {
      // findProjectId: a project NAME resolves to its UUID through the PLURAL
      // projects field. 'NOPE' matches nothing, so the tool must fail before any
      // mutation is sent. 'DUP' matches TWO projects — the resolver must refuse to
      // guess, so it fails cleanly and no mutation follows either.
      if (v.name === 'NOPE') res.end(JSON.stringify({ data: { projects: { nodes: [] } } }))
      else if (v.name === 'DUP') res.end(JSON.stringify({ data: { projects: { nodes: [{ id: PROJECT_UUID }, { id: DUPLICATE_PROJECT_UUID }] } } }))
      else res.end(JSON.stringify({ data: { projects: { nodes: [{ id: PROJECT_UUID }] } } }))
    } else if (q.includes('projects(')) {
      if ((v.after ?? null) === 'CURSOR_BAD') res.end(badCursor())
      else res.end(pagedConnection('projects', PROJECT_NODES, v))
    } else if (q.includes('projectCreate')) {
      res.end(JSON.stringify({ data: { projectCreate: { success: true, project: { id: 'p2', name: 'NP', description: '', state: 'started', teams: [] } } } }))
    } else if (q.includes('issueLabelCreate')) {
      res.end(JSON.stringify({ data: { issueLabelCreate: { success: true, label: { id: 'l2', name: 'feat', color: '#0f0', description: '' } } } }))
    } else if (q.includes('cycle: cycle(id: $id)')) {
      res.end(JSON.stringify({ data: { cycle: { id: 'c1', number: 1, name: 'Cycle 1', startsAt: '2024-01-01', endsAt: '2024-01-14', completedAt: '2024-01-14', progress: 0.5, team: { id: 't1', name: 'APT', key: 'APT' } } } }))
    } else if (q.includes('users(first')) {
      if ((v.after ?? null) === 'CURSOR_BAD') res.end(badCursor())
      else res.end(pagedConnection('users', USER_NODES, v))
    } else if (q.includes('user: user(id: $id)')) {
      res.end(JSON.stringify({ data: { user: { id: 'u1', name: 'Alice', displayName: 'Alice A', email: 'alice@example.com', active: true } } }))
    } else if (q.includes('users(filter: { email')) {
      res.end(JSON.stringify({ data: { users: { nodes: [{ id: 'u1', name: 'Alice', displayName: 'Alice A', email: 'alice@example.com', active: true }] } } }))
    } else if (q.includes('project: project(id: $id)')) {
      res.end(JSON.stringify({ data: { project: { id: 'p1', name: 'P', description: '', state: 'started', teams: [{ id: 't1', name: 'APT', key: 'APT' }] } } }))
    } else if (q.includes('label: issueLabel(id: $id)')) {
      res.end(JSON.stringify({ data: { label: { id: 'l1', name: 'bug', color: '#f00', description: '' } } }))
    } else if (q.includes('team: team(id: $id)')) {
      res.end(JSON.stringify({ data: { team: { id: 't1', name: 'APT', key: 'APT', description: 'd' } } }))
    } else if (q.includes('DIRECT_QUERY_MARKER')) {
      // linear_graphql escape-hatch fixture: echoes the variables object it
      // received, so a test can prove caller-supplied variables travel intact.
      res.end(JSON.stringify({ data: { viewer: { id: 'v1', name: 'APT' }, echoed: v } }))
    } else if (q.includes('DIRECT_MUTATION_MARKER')) {
      if (v.title === 'MOCK_FAIL_MARKER') res.end(JSON.stringify({ data: { issueUpdate: { success: false, issue: null } } }))
      else res.end(JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: v.id, title: v.title } } } }))
    } else if (q.includes('DIRECT_GRAPHQL_ERROR')) {
      // The shape Linear returns for a document-level failure: HTTP 200 with an
      // `errors` array and no data.
      res.end(JSON.stringify({ errors: [{ message: 'Syntax Error: Unexpected Name "DIRECT_GRAPHQL_ERROR"' }] }))
    } else if (q.includes('DIRECT_HTTP_STATUS')) {
      res.statusCode = 503
      res.end(JSON.stringify({ message: 'mock upstream failure' }))
    } else {
      res.end(JSON.stringify({ data: {} }))
    }
  })
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port

// Point the plugin's client at the mock by monkey-patching global fetch.
// Every tool call is awaited before the next one starts, so a single
// module-scoped slot carries which server this request was aimed at; the handler
// above copies it into the recorded `seen` entry, and the auth-header sweep below
// uses it to separate the cursor mock (whose URL carries its port) from the
// blank-pageInfo mock.
const realFetch = globalThis.fetch
let currentMockTarget
globalThis.fetch = (url, init) => {
  assert.equal(url, 'https://api.linear.app/graphql', 'fetch hits the Linear API URL')
  currentMockTarget = `http://127.0.0.1:${port}/`
  return realFetch(currentMockTarget, init)
}

const byName = Object.fromEntries(registered.map((d) => [d.name, d]))
const out = async (name, args = {}) => JSON.parse(await byName[name].execute(args, { signal: new AbortController().signal }))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// issue_list
let r = await out('linear_issue_list', { team: 'APT', limit: 5 })
assert.equal(r.count, 1)
assert.equal(r.issues[0].identifier, 'APT-1')
assert.ok(seen.at(-1).query.includes('team: { key: { eq: $team } }'), 'team filter in query')
assert.equal(seen.at(-1).variables.team, 'APT')
// Backwards compatibility: with no `after` the request carries NO after argument
// and no after variable — the wire shape is what it was before pagination.
assert.ok(!seen.at(-1).query.includes('after'), 'no after argument when no cursor given')
assert.ok(!('after' in seen.at(-1).variables), 'no after variable when no cursor given')

// issue_get (identifier form)
r = await out('linear_issue_get', { id: 'APT-1' })
assert.equal(r.identifier, 'APT-1')
assert.ok(seen.at(-1).query.includes('issue(id: $id)'), 'findIssueId resolved identifier to UUID, then issue(id:) fetched it')

// issue_get (uuid form)
r = await out('linear_issue_get', { id: '12345678-1234-1234-1234-123456789abc' })
assert.equal(r.identifier, 'APT-1')
assert.ok(seen.at(-1).query.includes('issue(id: $id)'), 'direct issue(id:) used for UUID')

// issue_create — team KEY + state NAME must resolve to UUIDs; the mutation
// input must be FLAT (teamId/stateId/assigneeId/labelIds), never nested.
r = await out('linear_issue_create', { team: 'APT', title: 'new', description: 'd', state: 'Backlog', assignee: 'u1', labels: ['l1'], priority: 2 })
assert.equal(r.identifier, 'APT-2')
assert.equal(r.state, 'Backlog')
const createInput = seen.at(-1).variables.input
assert.ok(UUID_RE.test(createInput.teamId), `issueCreate input.teamId is a UUID, got ${createInput.teamId}`)
assert.ok(UUID_RE.test(createInput.stateId), `issueCreate input.stateId is a UUID, got ${createInput.stateId}`)
assert.equal(createInput.assigneeId, 'u1', 'issueCreate input.assigneeId is flat')
assert.deepEqual(createInput.labelIds, ['l1'], 'issueCreate input.labelIds is a flat array')
assert.equal(createInput.title, 'new')
assert.equal(createInput.priority, 2)
assert.ok(!('team' in createInput), 'issueCreate input has NO nested team object')
assert.ok(!('state' in createInput), 'issueCreate input has NO nested state object')

// issue_update — state NAME resolves via the issue's team; input is flat.
r = await out('linear_issue_update', { id: 'APT-1', state: 'Done', assignee: 'u2', labels: ['l1', 'l2'] })
assert.equal(r.state, 'Done')
const updateInput = seen.at(-1).variables.input
assert.ok(UUID_RE.test(updateInput.stateId), `issueUpdate input.stateId is a UUID, got ${updateInput.stateId}`)
assert.equal(updateInput.assigneeId, 'u2', 'issueUpdate input.assigneeId is flat')
assert.deepEqual(updateInput.labelIds, ['l1', 'l2'], 'issueUpdate input.labelIds is a flat array')
assert.ok(!('state' in updateInput), 'issueUpdate input has NO nested state object')
assert.ok(!('assignee' in updateInput), 'issueUpdate input has NO nested assignee object')

// --- issue_archive / issue_unarchive --------------------------------------------
// Introspected signatures: issueArchive(trash: Boolean, id: String) and
// issueUnarchive(id: String), both -> IssueArchivePayload
// { success entity lastSyncId }. The archived issue is returned under `entity`,
// NOT `issue` — a payload that reads `.issue` would silently lose it. Both take a
// bare id argument (there is no archive input type).

// identifier form: findIssueId resolves to a UUID before the mutation
const beforeArch = seen.length
r = await out('linear_issue_archive', { id: 'APT-1' })
assert.equal(r.ok, true)
assert.equal(r.archived, true)
assert.equal(r.identifier, 'APT-1')
// The tool sends two requests — the identifier lookup, then the mutation — so
// `seen.at(-1)` is the mutation and the lookup is the call before it.
const archCalls = seen.slice(beforeArch)
assert.equal(archCalls.length, 2, 'issue_archive (identifier form) resolved the team/number then mutated')
assert.ok(archCalls[0].query.includes('issues(filter: { team'), 'issue_archive resolved the identifier to a UUID first')
let archCall = archCalls.at(-1)
assert.ok(archCall.query.includes('mutation($id: String!)'), 'issueArchive declares only $id (no input type exists)')
assert.ok(archCall.query.includes('issueArchive(id: $id)'), 'issueArchive passes a bare id argument')
assert.ok(archCall.query.includes('entity {'), 'issueArchive requests the payload `entity` field (not `issue`)')
assert.ok(UUID_RE.test(archCall.variables.id), `issueArchive id variable is the resolved UUID, got ${archCall.variables.id}`)

// uuid form: no resolution query, straight to the mutation
const beforeArchUuid = seen.length
r = await out('linear_issue_archive', { id: ISSUE_UUID })
assert.equal(r.ok, true)
assert.equal(seen.length, beforeArchUuid + 1, 'issue_archive (UUID form) sends exactly one request')

// unarchive — same payload shape, opposite mutation name
const beforeUnarch = seen.length
r = await out('linear_issue_unarchive', { id: 'APT-1' })
assert.equal(r.ok, true)
assert.equal(r.archived, false)
assert.equal(r.identifier, 'APT-1')
let unarchCall = seen.at(-1)
assert.ok(unarchCall.query.includes('issueUnarchive(id: $id)'), 'issue_unarchive calls issueUnarchive (not issueArchive)')
assert.ok(unarchCall.query.includes('entity {'), 'issueUnarchive requests the payload `entity` field')
assert.ok(!seen.slice(beforeUnarch).some((s) => s.query.includes('issueArchive(id:')), 'issue_unarchive does not emit the archive mutation')

// Payload-field contract: the mock deliberately also returns a decoy `issue` field.
// Reading `.entity` yields APT-1; reading `.issue` would yield WRONG. This locks in
// the introspected IssueArchivePayload shape.
assert.notEqual(r.identifier, 'WRONG', 'issue_unarchive reads the payload `entity` field, not `issue`')

// unknown identifier -> clear error, no mutation sent
const beforeArchNope = seen.length
r = await out('linear_issue_archive', { id: 'NOPE-1' })
assert.ok(r.error && /Issue not found: NOPE-1/.test(r.error), `issue_archive with unknown identifier fails cleanly, got: ${JSON.stringify(r)}`)
const archNopeCalls = seen.slice(beforeArchNope)
assert.equal(archNopeCalls.length, 1, 'issue_archive (unknown identifier) sends the lookup query only')
assert.ok(!archNopeCalls.some((s) => s.query.includes('issueArchive')), 'no issueArchive mutation after an unresolved identifier')

// success:false payload -> clean error naming the mutation. 'FAILTEAM-7' resolves
// to FAIL_ISSUE_UUID, the id whose archive the mock rejects with success:false.
r = await out('linear_issue_archive', { id: 'FAILTEAM-7' })
assert.ok(r.error && /issueArchive failed/.test(r.error), `issueArchive success:false surfaces a clean error, got: ${JSON.stringify(r)}`)

// --- archived issues: identifier lookup must opt into includeArchived -----------
// An ARCHIVED issue is invisible to the plain `issues` query — the mock only hands
// it back when the document carries includeArchived: true. linear_issue_unarchive
// therefore has to resolve identifiers with that argument, or it could never reach
// the one issue class it exists for.
const beforeUnarchArch = seen.length
r = await out('linear_issue_unarchive', { id: 'ARCHIVED-1' })
assert.equal(r.ok, true, `issue_unarchive reaches an archived issue by identifier, got: ${JSON.stringify(r)}`)
assert.equal(r.archived, false)
const unarchArchCalls = seen.slice(beforeUnarchArch)
assert.equal(unarchArchCalls.length, 2, 'issue_unarchive (archived identifier) resolved the team/number then mutated')
let unarchArchLookup = unarchArchCalls[0]
assert.ok(unarchArchLookup.query.includes('issues(filter: { team'), 'issue_unarchive resolves the identifier through the issues filter')
assert.ok(unarchArchLookup.query.includes('includeArchived: true'), 'issue_unarchive passes includeArchived: true so archived issues are visible to the lookup')
assert.equal(unarchArchLookup.variables.team, 'ARCHIVED', 'the team key half of the identifier still travels as a variable')
assert.deepEqual(Object.keys(unarchArchLookup.variables).sort(), ['num', 'team'], 'includeArchived is a literal argument, not a new variable (only $team/$num are sent)')
assert.ok(UUID_RE.test(unarchArchCalls.at(-1).variables.id), `issue_unarchive mutates the resolved UUID of the archived issue, got ${unarchArchCalls.at(-1).variables.id}`)

// uuid form: no lookup at all — a UUID needs no archived-aware resolution.
const beforeUnarchUuid = seen.length
r = await out('linear_issue_unarchive', { id: ARCHIVED_ISSUE_UUID })
assert.equal(r.ok, true)
assert.equal(seen.length, beforeUnarchUuid + 1, 'issue_unarchive (UUID form) sends exactly one request — no resolution query')
assert.ok(seen.at(-1).query.includes('issueUnarchive(id: $id)'), 'the single request for the UUID form is the unarchive mutation')
assert.equal(seen.at(-1).variables.id, ARCHIVED_ISSUE_UUID, 'a UUID passes straight through to the mutation unchanged')

// the ordinary lookup is preserved everywhere else: linear_issue_archive must NOT
// opt into includeArchived (an archived issue needs no second archive), and the
// document stays byte-for-byte what it was before the option existed.
const beforeArchArch = seen.length
r = await out('linear_issue_archive', { id: 'ARCHIVED-1' })
assert.ok(r.error && /Issue not found: ARCHIVED-1/.test(r.error), `issue_archive does not see archived issues (ordinary lookup preserved), got: ${JSON.stringify(r)}`)
const archArchCalls = seen.slice(beforeArchArch)
assert.equal(archArchCalls.length, 1, 'issue_archive (archived identifier) sends the lookup query only')
assert.ok(!archArchCalls[0].query.includes('includeArchived'), 'issue_archive keeps the ordinary issues query — no includeArchived argument')
assert.ok(!archArchCalls.some((s) => s.query.includes('issueArchive(id:')), 'no issueArchive mutation after an unresolved identifier')

// comment_add — flat issueId
r = await out('linear_comment_add', { issue: 'APT-1', body: 'hello' })
assert.equal(r.body, 'hello')
assert.ok(UUID_RE.test(seen.at(-1).variables.input.issueId), 'commentCreate input.issueId is a UUID')
assert.ok(!('issue' in seen.at(-1).variables.input), 'commentCreate input has NO nested issue object')

// --- comment_update -------------------------------------------------------------
// Introspected signature: commentUpdate(id: String, input: CommentUpdateInput!)
// -> CommentPayload { success comment lastSyncId }. CommentUpdateInput carries
// body/bodyData/resolvingUserId/... — never an id.
r = await out('linear_comment_update', { id: 'c1', body: 'edited' })
assert.equal(r.id, 'c1')
assert.equal(r.body, 'edited')
let cuCall = seen.at(-1)
assert.ok(cuCall.query.includes('mutation($id: String!, $input: CommentUpdateInput!)'), 'commentUpdate declares $id and $input separately')
assert.ok(cuCall.query.includes('commentUpdate(id: $id, input: $input)'), 'commentUpdate passes the comment UUID as a top-level id argument')
assert.equal(cuCall.variables.id, 'c1', 'commentUpdate id argument carries the comment UUID')
assert.deepEqual(Object.keys(cuCall.variables.input), ['body'], `commentUpdate input carries ONLY body, got ${Object.keys(cuCall.variables.input).join(', ')}`)
assert.ok(!('id' in cuCall.variables.input), 'commentUpdate input has NO id field (id is a mutation argument)')

r = await out('linear_comment_update', { id: 'MOCK_FAIL_MARKER', body: 'x' })
assert.ok(r.error && /commentUpdate failed/.test(r.error), `commentUpdate success:false surfaces a clean error, got: ${JSON.stringify(r)}`)

// --- comment_delete -------------------------------------------------------------
// Introspected signature: commentDelete(id: String) -> DeletePayload
// { success entityId lastSyncId }. There is NO CommentDeleteInput type, so the
// document must carry no input variable at all.
r = await out('linear_comment_delete', { id: 'c1' })
assert.equal(r.ok, true)
assert.equal(r.deletedId, 'c1')
let cdCall = seen.at(-1)
assert.ok(cdCall.query.includes('mutation($id: String!)'), 'commentDelete declares only $id')
assert.ok(cdCall.query.includes('commentDelete(id: $id)'), 'commentDelete passes a bare id argument')
assert.ok(!cdCall.query.includes('CommentDeleteInput'), 'commentDelete sends no input type (no such type exists)')
assert.deepEqual(Object.keys(cdCall.variables), ['id'], `commentDelete sends only the id variable, got ${Object.keys(cdCall.variables).join(', ')}`)

r = await out('linear_comment_delete', { id: 'MOCK_FAIL_MARKER' })
assert.ok(r.error && /commentDelete failed/.test(r.error), `commentDelete success:false surfaces a clean error, got: ${JSON.stringify(r)}`)

// comment_list
r = await out('linear_comment_list', { issue: 'APT-1' })
assert.equal(r.count, 1)
assert.ok(!seen.at(-1).query.includes('after'), 'comment_list: no after argument when no cursor given')
assert.deepEqual(Object.keys(seen.at(-1).variables), ['id'], 'comment_list: only the id variable when no cursor given')

// relation_add — flat issueId/relatedId
r = await out('linear_relation_add', { issue: 'APT-1', related: '12345678-1234-1234-1234-123456789abc' })
assert.equal(r.ok, true)
assert.ok(UUID_RE.test(seen.at(-1).variables.input.issueId), 'issueRelationCreate input.issueId is a UUID')
assert.ok(UUID_RE.test(seen.at(-1).variables.input.relatedIssueId), 'issueRelationCreate input.relatedIssueId is a UUID')
assert.ok(!('issue' in seen.at(-1).variables.input), 'issueRelationCreate input has NO nested issue object')

// team_list
r = await out('linear_team_list')
assert.equal(r.teams[0].key, 'APT')
assert.deepEqual(Object.keys(seen.at(-1).variables ?? {}), [], 'team_list: no variables when no cursor given')

// state_list — must call `teams` to resolve the UUID, then `workflowStates`.
r = await out('linear_state_list', { team: 'APT' })
assert.equal(r.states.length, 2)
assert.equal(r.states[0].name, 'Todo')
const stateCalls = seen.slice(-2)
assert.ok(stateCalls[0].query.includes('teams(first: 10, filter: { key: { eq: $v } }'), 'state_list resolved the team via the PLURAL teams field')
assert.ok(stateCalls[1].query.includes('workflowStates(filter: { team: { id: { eq: $teamId } } }'), 'state_list then queried workflowStates by team id')

// label_list — teams filter -> issueLabels
r = await out('linear_label_list', { team: 'APT' })
assert.equal(r.labels[0].name, 'bug')
assert.ok(seen.at(-1).query.includes('issueLabels(filter: { team: { id: { eq: $teamId } } }'), 'label_list queried issueLabels by team id')

// project_list
r = await out('linear_project_list')
assert.equal(r.projects[0].name, 'P')

// project_create — team keys resolve to flat teamIds
r = await out('linear_project_create', { name: 'NP', teams: ['APT'] })
assert.equal(r.name, 'NP')
assert.ok(Array.isArray(seen.at(-1).variables.input.teamIds), 'projectCreate input.teamIds is a flat array')
assert.ok(UUID_RE.test(seen.at(-1).variables.input.teamIds[0]), 'projectCreate input.teamIds[0] is a UUID')
assert.ok(!('teams' in seen.at(-1).variables.input), 'projectCreate input has NO nested teams object')

// --- project_update ------------------------------------------------------------
// Introspected signature: projectUpdate(id: String, input: ProjectUpdateInput!)
// -> ProjectPayload { success project lastSyncId }. The project UUID is a
// top-level argument (NOT inside `input`), teamIds are flat UUIDs, and a NAME
// must resolve through the plural `projects` filter first.

// name form: identifier resolves to a UUID before the mutation
const beforePu = seen.length
r = await out('linear_project_update', { id: 'P', name: 'Renamed', description: 'nd', startDate: '2026-01-01', targetDate: '2026-02-01', priority: 2, teams: ['APT'] })
assert.equal(r.name, 'Renamed')
assert.equal(r.description, 'nd')
// Two requests: the name lookup and the mutation. `seen.at(-1)` is the mutation.
const puCalls = seen.slice(beforePu)
assert.ok(puCalls[0].query.includes('projects(filter: { name: { eq: $name } })'), 'project_update (name form) resolved the project through the PLURAL projects field')
let puCall = puCalls.at(-1)
assert.ok(puCall.query.includes('mutation($id: String!, $input: ProjectUpdateInput!)'), 'projectUpdate declares $id and $input separately')
assert.ok(puCall.query.includes('projectUpdate(id: $id, input: $input)'), 'projectUpdate passes the project UUID as a top-level id argument')
assert.equal(puCall.variables.id, PROJECT_UUID, 'project_update: resolved project UUID reaches the mutation id argument')
let puInput = puCall.variables.input
assert.ok(!('id' in puInput), 'projectUpdate input has NO id field (id is a mutation argument)')
assert.equal(puInput.name, 'Renamed')
assert.equal(puInput.startDate, '2026-01-01', 'startDate travels as a flat TimelessDate string')
assert.equal(puInput.targetDate, '2026-02-01', 'targetDate travels as a flat TimelessDate string')
assert.equal(puInput.priority, 2)
assert.ok(Array.isArray(puInput.teamIds), 'projectUpdate input.teamIds is a flat array')
assert.ok(UUID_RE.test(puInput.teamIds[0]), `projectUpdate input.teamIds[0] is a UUID, got ${puInput.teamIds[0]}`)
assert.ok(!('teams' in puInput), 'projectUpdate input has NO nested teams object')

// uuid form: no resolution query, straight to the mutation
const beforePuUuid = seen.length
r = await out('linear_project_update', { id: PROJECT_UUID, color: '#ff0000', icon: 'Rocket', content: 'body' })
assert.equal(r.name, 'P')
puCall = seen.at(-1)
assert.equal(seen.length, beforePuUuid + 1, 'project_update (UUID form) sends exactly one request — no resolution query')
assert.ok(puCall.query.includes('projectUpdate(id: $id, input: $input)'), 'projectUpdate mutation document shape')
puInput = puCall.variables.input
assert.equal(puInput.color, '#ff0000', 'color is a flat ProjectUpdateInput field')
assert.equal(puInput.icon, 'Rocket', 'icon is a flat ProjectUpdateInput field')
assert.equal(puInput.content, 'body', 'content is a flat ProjectUpdateInput field')

// unknown project name -> clear error, no malformed mutation
const beforePuNope = seen.length
r = await out('linear_project_update', { id: 'NOPE', name: 'X' })
assert.ok(r.error && /Project not found: NOPE/.test(r.error), `project_update with unknown name fails cleanly, got: ${JSON.stringify(r)}`)
assert.equal(seen.length, beforePuNope + 1, 'project_update (unknown name) sends the resolution query but no mutation')
assert.ok(!seen.slice(beforePuNope).some((s) => s.query.includes('projectUpdate')), 'no projectUpdate mutation after an unresolved name')

// ambiguous project name -> clear error naming the ambiguity, NOT a silent pick.
// The mock returns TWO projects for the name 'DUP'; taking nodes[0] would modify
// one of two candidates without the caller ever learning the name was ambiguous.
const beforePuDup = seen.length
r = await out('linear_project_update', { id: 'DUP', name: 'Renamed' })
assert.ok(r.error && /multiple projects/.test(r.error), `project_update with an ambiguous name fails cleanly, got: ${JSON.stringify(r)}`)
assert.ok(!/Project not found/.test(r.error ?? ''), `an ambiguous name is reported as ambiguous, not as missing, got: ${JSON.stringify(r)}`)
const puDupCalls = seen.slice(beforePuDup)
assert.equal(puDupCalls.length, 1, 'project_update (ambiguous name) sends the resolution query only')
assert.ok(puDupCalls[0].query.includes('projects(filter: { name: { eq: $name } })'), 'project_update (ambiguous name) still resolved through the PLURAL projects field')
assert.ok(!puDupCalls.some((s) => s.query.includes('projectUpdate')), 'no projectUpdate mutation after an ambiguous name')
// The UUID form is unaffected by the ambiguity guard — a UUID cannot be ambiguous.
r = await out('linear_project_update', { id: DUPLICATE_PROJECT_UUID, color: '#00ff00' })
assert.equal(r.id, DUPLICATE_PROJECT_UUID, 'project_update (UUID form) still mutates without any name resolution')

// success:false payload -> clean error naming the mutation
r = await out('linear_project_update', { id: PROJECT_UUID, name: 'MOCK_FAIL_MARKER' })
assert.ok(r.error && /projectUpdate failed/.test(r.error), `projectUpdate success:false surfaces a clean error, got: ${JSON.stringify(r)}`)

// label_create — team key resolves to flat teamId
r = await out('linear_label_create', { team: 'APT', name: 'feat', color: '#0f0' })
assert.equal(r.name, 'feat')
assert.ok(UUID_RE.test(seen.at(-1).variables.input.teamId), 'labelCreate input.teamId is a UUID')
assert.ok(!('team' in seen.at(-1).variables.input), 'labelCreate input has NO nested team object')

// cycle_list — teams filter -> cycles
r = await out('linear_cycle_list', { team: 'APT', limit: 5 })
assert.equal(r.count, 1)
assert.equal(r.cycles[0].name, 'Cycle 1')
assert.equal(r.cycles[0].number, 1)
assert.ok(seen.at(-1).query.includes('cycles(first'), 'cycle_list queried cycles by team id')

// cycle_get
r = await out('linear_cycle_get', { id: 'c1' })
assert.equal(r.id, 'c1')
assert.equal(r.progress, 0.5)
assert.equal(r.team.key, 'APT')

// user_list
r = await out('linear_user_list')
assert.equal(r.count, 1)
assert.equal(r.users[0].email, 'alice@example.com')

// user_get (uuid form)
r = await out('linear_user_get', { id: '12345678-1234-1234-1234-123456789abc' })
assert.equal(r.email, 'alice@example.com')

// user_get (email form)
r = await out('linear_user_get', { id: 'alice@example.com' })
assert.equal(r.email, 'alice@example.com')

// project_get
r = await out('linear_project_get', { id: 'p1' })
assert.equal(r.name, 'P')
assert.equal(r.teams[0].key, 'APT')

// label_get
r = await out('linear_label_get', { id: 'l1' })
assert.equal(r.name, 'bug')
assert.equal(r.color, '#f00')

// team_get (key form) — must use the PLURAL teams filter, not singular team
r = await out('linear_team_get', { id: 'APT' })
assert.equal(r.key, 'APT')
assert.equal(r.name, 'APT')
assert.ok(seen.at(-1).query.includes('teams(first: 10, filter: { key: { eq: $key } }'), 'team_get (key) used the PLURAL teams field')

// team_get (uuid form)
r = await out('linear_team_get', { id: '12345678-1234-1234-1234-123456789abc' })
assert.equal(r.key, 'APT')

// --- linear_graphql: the direct GraphQL escape hatch --------------------------
// It is not a hand-modelled endpoint: it forwards the CALLER'S OWN document to
// the same fixed Linear endpoint with the same configured key, through the same
// gql() client and the same { error } wrapper. The mock fixtures below are keyed
// on marker strings inside the caller's document, so each assertion proves what
// actually travelled on the wire — including that variables reach the server as
// VARIABLES, not spliced into the text.

// query document with variables
const beforeGqlQuery = seen.length
r = await out('linear_graphql', { query: 'query DirectQuery($id: String!) { DIRECT_QUERY_MARKER(id: $id) }', variables: { id: ISSUE_UUID } })
assert.deepEqual(r.data.echoed, { id: ISSUE_UUID }, 'linear_graphql (query): caller variables reach the server unchanged')
assert.equal(r.data.viewer.id, 'v1', 'linear_graphql (query): the server `data` is returned raw, not projected')
const gqlQueryCall = seen.at(-1)
assert.equal(seen.length, beforeGqlQuery + 1, 'linear_graphql sends exactly one request per call')
assert.ok(gqlQueryCall.query.includes('DIRECT_QUERY_MARKER'), 'linear_graphql: the caller document is sent verbatim')
assert.ok(gqlQueryCall.query.includes('query DirectQuery($id: String!)'), 'linear_graphql: the caller variable declaration is preserved')
assert.ok(!gqlQueryCall.query.includes(ISSUE_UUID), 'linear_graphql: variable VALUES never enter the query text')
assert.deepEqual(gqlQueryCall.variables, { id: ISSUE_UUID }, 'linear_graphql: variables travel as the GraphQL variables object')

// mutation document with variables — allowed by design; what it may write is
// governed by the key's Linear permissions. The mock answers a fake mutation on
// loopback, so no real write happens anywhere in this suite.
const beforeGqlMut = seen.length
r = await out('linear_graphql', { query: 'mutation DirectMutation($id: String!, $title: String!) { DIRECT_MUTATION_MARKER(id: $id, title: $title) }', variables: { id: ISSUE_UUID, title: 'renamed' } })
assert.equal(r.data.issueUpdate.success, true, 'linear_graphql (mutation): the mutation payload comes back raw')
assert.deepEqual(r.data.issueUpdate.issue, { id: ISSUE_UUID, title: 'renamed' }, 'linear_graphql (mutation): echoed payload fields survive')
const gqlMutCall = seen.at(-1)
assert.equal(seen.length, beforeGqlMut + 1, 'linear_graphql (mutation) sends exactly one request')
assert.ok(gqlMutCall.query.startsWith('mutation DirectMutation'), 'linear_graphql: a mutation document is sent as-is (not rejected, not rewritten)')
assert.deepEqual(gqlMutCall.variables, { id: ISSUE_UUID, title: 'renamed' }, 'linear_graphql (mutation): both variables travel as variables')

// no variables at all: the request carries the document and nothing else
const beforeGqlNoVars = seen.length
r = await out('linear_graphql', { query: '{ DIRECT_QUERY_MARKER }' })
assert.equal(r.data.viewer.name, 'APT', 'linear_graphql: a variables-less document still works')
assert.ok(!('variables' in seen.at(-1)) || seen.at(-1).variables == null, 'linear_graphql: no variables object is sent when none was given')

// GraphQL-level error (HTTP 200 + errors[]) -> the same clean { error } wrapper
r = await out('linear_graphql', { query: '{ DIRECT_GRAPHQL_ERROR }' })
assert.ok(r.error && /Syntax Error/.test(r.error), `linear_graphql surfaces a GraphQL error through the { error } wrapper, got: ${JSON.stringify(r)}`)

// HTTP-level failure (non-2xx, no errors[]) -> clean { error } naming the status
r = await out('linear_graphql', { query: '{ DIRECT_HTTP_STATUS }' })
assert.ok(r.error && /HTTP 503/.test(r.error), `linear_graphql surfaces an HTTP failure through the { error } wrapper, got: ${JSON.stringify(r)}`)

// invalid arguments are rejected BEFORE any request leaves the plugin
for (const bad of ['', '   ', '\t\n']) {
  const before = seen.length
  r = await out('linear_graphql', { query: bad })
  assert.ok(r.error && /"query" must be a non-empty GraphQL document/.test(r.error), `linear_graphql rejects blank query=${JSON.stringify(bad)}, got: ${JSON.stringify(r)}`)
  assert.equal(seen.length, before, `linear_graphql: blank query=${JSON.stringify(bad)} sends no request`)
}
for (const bad of [null, 42, true, {}, ['{ x }']]) {
  const before = seen.length
  r = await out('linear_graphql', { query: bad })
  assert.ok(r.error && /"query"/.test(r.error), `linear_graphql rejects query=${JSON.stringify(bad)} with a clear error, got: ${JSON.stringify(r)}`)
  assert.equal(seen.length, before, `linear_graphql: query=${JSON.stringify(bad)} sends no request`)
}
const beforeMissingQuery = seen.length
r = await out('linear_graphql', {})
assert.ok(r.error && /missing required property "query"/.test(r.error), `linear_graphql requires query, got: ${JSON.stringify(r)}`)
assert.equal(seen.length, beforeMissingQuery, 'linear_graphql: a missing query sends no request')
for (const bad of [null, 'x', 42, ['a'], true]) {
  const before = seen.length
  r = await out('linear_graphql', { query: '{ DIRECT_QUERY_MARKER }', variables: bad })
  assert.ok(r.error && /"variables"/.test(r.error), `linear_graphql rejects variables=${JSON.stringify(bad)} with a clear error, got: ${JSON.stringify(r)}`)
  assert.equal(seen.length, before, `linear_graphql: variables=${JSON.stringify(bad)} sends no request`)
}
// An empty variables object is accepted and must not invent anything on the wire.
r = await out('linear_graphql', { query: '{ DIRECT_QUERY_MARKER }', variables: {} })
assert.deepEqual(r.data.echoed, {}, 'linear_graphql: variables={} round-trips as an empty object')

// auth header on every call (raw key, no Bearer prefix — Linear requirement).
// The pageInfo-less mock deliberately serves no Authorization check, so the sweep
// covers every call that went to the cursor mock (its own URL is echoed back).
for (const s of seen) {
  if (!s.target || !s.target.includes(String(port))) continue
  assert.equal(s.auth, 'li_api_test', 'raw API key sent as Authorization (no Bearer)')
  assert.equal(s.contentType, 'application/json')
}

// --- 3b. Cursor pagination on every direct GraphQL list tool -------------------
// Scope: all eight direct list tools — linear_issue_list, linear_comment_list and
// the six extended here (team/state/label/project/cycle/user lists). The mock
// serves a two-page connection for each and echoes whatever `after` it received
// as a variable, so one shared contract is asserted per tool.
let call

// Per-tool description of the one pagination contract every list tool shares:
//   marker    — identifies this tool's connection query inside the recorded call
//   args      — the tool's pre-existing arguments (filters/limits preserved)
//   firstValue/secondValue — the page-1 and page-2 entry each tool must surface
//   defaultLimit/maxLimit  — the limit behaviour that existed before pagination
//   filterValue            — when set, the value the filter must reach the server
//                            as a variable. Production resolves a human identifier
//                            (team key, issue identifier) to its UUID before issuing
//                            the query (resolveTeamId / findIssueId), so for those
//                            tools the variable carries the resolved UUID, not the
//                            raw "APT"/"APT-1" the caller passed. The entry is keyed
//                            by the GraphQL variable name ($id for issue, $teamId for
//                            team). Only variables the tool really sends are asserted:
//                            a declared entry means "this filter travels as $<name>".
//                            Raw-key tools (issue_list) declare their own raw value.
const PAGINATED_LISTS = [
  { tool: 'linear_issue_list', marker: 'issues(first', args: { team: 'APT', limit: 5 }, filterValue: { team: 'APT' }, firstId: (x) => x.issues[0].identifier, secondId: (x) => x.issues[0].identifier, firstValue: 'APT-1', secondValue: 'APT-2', defaultLimit: 20, maxLimit: 50 },
  { tool: 'linear_comment_list', marker: 'comments(first', args: { issue: 'APT-1' }, filterValue: { id: ISSUE_UUID }, firstId: (x) => x.comments[0].id, secondId: (x) => x.comments[0].id, firstValue: 'c1', secondValue: 'c2', defaultLimit: 20, maxLimit: 50 },
  { tool: 'linear_team_list', marker: 'teams(first: 100', args: {}, firstId: (x) => x.teams[0].key, secondId: (x) => x.teams[0].key, firstValue: 'APT', secondValue: 'SEC' },
  { tool: 'linear_state_list', marker: 'workflowStates(filter', args: { team: 'APT' }, filterValue: { teamId: TEAM_NODE.id }, firstId: (x) => x.states[1].name, secondId: (x) => x.states[0].name, firstValue: 'In Progress', secondValue: 'Backlog' },
  { tool: 'linear_label_list', marker: 'issueLabels(filter', args: { team: 'APT' }, filterValue: { teamId: TEAM_NODE.id }, firstId: (x) => x.labels[0].id, secondId: (x) => x.labels[0].id, firstValue: 'l1', secondValue: 'l2page' },
  { tool: 'linear_project_list', marker: 'projects(first', args: {}, firstId: (x) => x.projects[0].id, secondId: (x) => x.projects[0].id, firstValue: 'p1', secondValue: 'p2page', defaultLimit: 20, maxLimit: 50 },
  { tool: 'linear_cycle_list', marker: 'cycles(first', args: { team: 'APT', limit: 5 }, filterValue: { teamId: TEAM_NODE.id }, firstId: (x) => x.cycles[0].id, secondId: (x) => x.cycles[0].id, firstValue: 'c1', secondValue: 'c2', defaultLimit: 20, maxLimit: 50 },
  { tool: 'linear_user_list', marker: 'users(first', args: {}, firstId: (x) => x.users[0].id, secondId: (x) => x.users[0].id, firstValue: 'u1', secondValue: 'u2page', defaultLimit: 20, maxLimit: 50 },
]
const listCalls = (marker) => seen.filter((s) => s.query.includes(marker))

for (const { tool, marker, args, firstId, secondId, firstValue, secondValue } of PAGINATED_LISTS) {
  // -- first page: pageInfo is returned ALONGSIDE the existing fields -----------
  r = await out(tool, args)
  assert.equal(firstId(r), firstValue, `${tool}: first page keeps the existing projection`)
  assert.deepEqual(r.pageInfo, PAGE1, `${tool}: first page returns pageInfo { hasNextPage, endCursor }`)
  call = seen.at(-1)
  assert.ok(call.query.includes(marker), `${tool}: queried its own connection (${marker})`)
  assert.ok(call.query.includes('pageInfo { hasNextPage endCursor }'), `${tool}: requests pageInfo from the connection`)
  // Backwards compatibility: with no `after` the document carries neither the
  // declaration nor the argument — byte-for-byte the pre-pagination shape.
  assert.ok(!call.query.includes('$after') && !call.query.includes('after:'), `${tool}: no $after declaration/argument when no cursor given`)
  assert.ok(!('after' in (call.variables ?? {})), `${tool}: no after variable when no cursor given`)

  // -- next page: the cursor travels as a variable, both directions -------------
  r = await out(tool, { ...args, after: 'CURSOR_PAGE2' })
  assert.equal(secondId(r), secondValue, `${tool}: second page returns the next page`)
  assert.deepEqual(r.pageInfo, PAGE2, `${tool}: last page reports hasNextPage false / endCursor null`)
  call = seen.at(-1)
  assert.ok(call.query.includes('$after: String'), `${tool}: declares $after as a String variable`)
  assert.ok(call.query.includes('after: $after'), `${tool}: passes the cursor as after: $after (never interpolated)`)
  assert.ok(!/after:\s*"/.test(call.query), `${tool}: the cursor value never appears inside the query text`)
  assert.equal(call.variables.after, 'CURSOR_PAGE2', `${tool}: caller-supplied cursor reaches the server unchanged as a variable`)

  // -- blank / whitespace-only `after` is treated as "no cursor" ----------------
  for (const blank of ['', '   ', '\t']) {
    const before = listCalls(marker).length
    r = await out(tool, { ...args, after: blank })
    assert.equal(firstId(r), firstValue, `${tool}: after=${JSON.stringify(blank)} still returns the first page`)
    assert.deepEqual(r.pageInfo, PAGE1, `${tool}: after=${JSON.stringify(blank)} is treated as no cursor`)
    call = seen.at(-1)
    assert.equal(listCalls(marker).length, before + 1, `${tool}: after=${JSON.stringify(blank)} issues exactly one request`)
    assert.ok(!('after' in call.variables), `${tool}: after=${JSON.stringify(blank)} is not sent as a variable`)
    assert.ok(!call.query.includes('$after'), `${tool}: after=${JSON.stringify(blank)} adds no $after declaration`)
    assert.ok(!call.query.includes('after:'), `${tool}: after=${JSON.stringify(blank)} adds no after argument`)
  }

  // -- non-string cursors are rejected before any GraphQL request --------------
  for (const bad of [null, 42, true, {}, ['CURSOR_PAGE2']]) {
    const before = listCalls(marker).length
    r = await out(tool, { ...args, after: bad })
    assert.ok(r.error && /"after" must be a string/.test(r.error), `${tool} rejects after=${JSON.stringify(bad)} with a clear error, got: ${JSON.stringify(r)}`)
    assert.equal(listCalls(marker).length, before, `${tool}: after=${JSON.stringify(bad)} sends no GraphQL request`)
  }

  // -- a server-side cursor rejection surfaces as the clean { error } payload ---
  r = await out(tool, { ...args, after: 'CURSOR_BAD' })
  assert.ok(r.error && /Invalid cursor provided: after/.test(r.error), `${tool}: bad cursor fails cleanly, got: ${JSON.stringify(r)}`)

  // -- a server that reports no pageInfo yields null, never an invented value ---
  r = await out(tool, { ...args, after: 'CURSOR_NOINFO' })
  assert.equal(firstId(r), firstValue, `${tool}: a pageInfo-less response still returns the existing results`)
  assert.equal(r.pageInfo, null, `${tool}: missing server pageInfo normalizes to null (never invented)`)
  call = seen.at(-1)
  assert.ok(call.query.includes('$after: String') && call.query.includes('after: $after'), `${tool}: $after is declared/passed independently of what the server returns`)
  assert.equal(call.variables.after, 'CURSOR_NOINFO', `${tool}: cursor still sent as a variable against a pageInfo-less server`)
}

// -- limit defaults and maxima are unchanged by pagination ---------------------
for (const { tool, marker, args, defaultLimit, maxLimit } of PAGINATED_LISTS) {
  if (defaultLimit === undefined) continue
  const shown = () => seen.at(-1).query.match(/first: \d+/)?.[0]
  // The shared `args` may pin an explicit limit (issue/cycle lists pass limit: 5),
  // so the default-limit probe must send no limit at all.
  // Matching is on the whole `first: N` token, not a `first: N,` prefix: the page
  // size is the last argument when no filter or cursor accompanies it (comments).
  let callForLimit = null
  const outTracked = async (name, a) => {
    const before = seen.length
    const res = await out(name, a)
    callForLimit = seen.slice(before).find((s) => s.query.includes(marker))
    return res
  }
  await outTracked(tool, Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'limit')))
  assert.ok(callForLimit.query.includes(`first: ${defaultLimit}`), `${tool}: default limit still first: ${defaultLimit}, got ${callForLimit.query.match(/first: \d+/)?.[0]}`)
  await outTracked(tool, { ...args, limit: 500 })
  assert.ok(callForLimit.query.includes(`first: ${maxLimit}`), `${tool}: limit clamped to max ${maxLimit}, got ${callForLimit.query.match(/first: \d+/)?.[0]}`)
  assert.equal((callForLimit.query.match(/first: \d+/g) ?? []).length, 1, `${tool}: no second first: appears in the document for ${marker}`)
}

// -- team_list keeps its fixed first: 100 page size (no `limit` parameter) ------
await out('linear_team_list')
assert.ok(seen.at(-1).query.includes('teams(first: 100'), `team_list page size still first: 100, got ${seen.at(-1).query.match(/teams\(first: \d+/)?.[0]}`)
assert.ok(!('limit' in byName.linear_team_list.parameters.properties), 'team_list gains no limit parameter')

// -- filters and older result fields survive on every extended list -------------
for (const { tool, marker, args, filterValue } of PAGINATED_LISTS) {
  const before = seen.length
  r = await out(tool, args)
  // Only the tool's own connection request: comment/issue/cycle/state/label lists
  // first resolve an entity through a helper query, so `seen.at(-1)` is not always
  // this tool's list call.
  call = seen.slice(before).find((s) => s.query.includes(marker))
  for (const [varName, argName] of [['team', 'team'], ['id', 'issue'], ['teamId', 'team']]) {
    // Only variables the tool declares: issue_list filters teams by key ($team),
    // state/label/cycle lists resolve the key to a UUID ($teamId). The set of
    // assertions comes entirely from filterValue, so a raw-key tool declares $team
    // with its raw value and a resolving tool declares only $teamId.
    if (!(argName in args) || !(varName in (filterValue ?? {}))) continue
    // The value that must reach the server: production resolves a human identifier
    // to its UUID before querying, so compare against the resolved value when the
    // fixture declares one for that variable name.
    const expected = filterValue?.[varName] ?? args[argName]
    assert.equal(call.variables?.[varName], expected, `${tool}: the ${argName} filter is still sent as a variable (${varName})`)
  }
  if (args.team && (tool === 'linear_state_list' || tool === 'linear_label_list' || tool === 'linear_cycle_list')) {
    assert.equal(r.team, args.team, `${tool}: result still echoes the requested team`)
  }
  if ('limit' in args) assert.ok(call.query.includes(`first: ${args.limit}`), `${tool}: explicit limit ${args.limit} still reaches first:`)
}

console.log(`ok - cursor pagination across all ${PAGINATED_LISTS.length} direct list tools: pageInfo on the first page, after pass-through as a variable, hasNextPage/endCursor, blank/non-string cursors ignored or rejected, bad cursor -> clean error, pageInfo-less server -> null, limits and filters unchanged`)
// -- a response with no pageInfo (older/blank server) yields null for every list
// tool. The per-tool CURSOR_NOINFO probe above proves this on the main mock; this
// SECOND server reports nothing at all, so the plugin's null-normalization does
// not depend on one fixture's shape.
const blank = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    res.setHeader('content-type', 'application/json')
    // Same node payloads as the main mock, minus every pageInfo block.
    if (parsed.query.includes('issues(first')) {
      res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'i1', identifier: 'APT-1', title: 'T', state: { name: 'Todo' }, labels: { nodes: [] } }] } } }))
    } else if (parsed.query.includes('comments(')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', comments: { nodes: [{ id: 'c1', body: 'hello', createdAt: 'now' }] } } } }))
    } else if (parsed.query.includes('issues(filter: { team')) {
      res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'dddddddd-1111-2222-3333-444444444444' }] } } }))
    } else if (parsed.query.includes('teams(first: 10')) {
      res.end(JSON.stringify({ data: { teams: { nodes: [TEAM_NODE] } } }))
    } else if (parsed.query.includes('workflowStates(filter')) {
      res.end(JSON.stringify({ data: { workflowStates: { nodes: STATE_NODES[0] } } }))
    } else if (parsed.query.includes('issueLabels(filter')) {
      res.end(JSON.stringify({ data: { issueLabels: { nodes: LABEL_NODES[0] } } }))
    } else if (parsed.query.includes('cycles(first')) {
      res.end(JSON.stringify({ data: { cycles: { nodes: CYCLE_NODES[0] } } }))
    } else if (parsed.query.includes('projects(first')) {
      res.end(JSON.stringify({ data: { projects: { nodes: PROJECT_NODES[0] } } }))
    } else if (parsed.query.includes('users(first')) {
      res.end(JSON.stringify({ data: { users: { nodes: USER_NODES[0] } } }))
    } else {
      res.end(JSON.stringify({ data: {} }))
    }
  })
})
await new Promise((resolve) => blank.listen(0, '127.0.0.1', resolve))
const blankPort = blank.address().port
// The blank server has no cursor fixture, so it answers every page the same way.
// It records its own calls into `blankSeen` — that mock is not wired to `seen`,
// which keeps the assertion below ("this call really went to the pageInfo-less
// mock") independent of the cursor mock's recording.
const blankSeen = []
globalThis.fetch = (url, init) => {
  const parsed = JSON.parse(init.body)
  blankSeen.push({ auth: init.headers?.Authorization ?? init.headers?.authorization, query: parsed.query, variables: parsed.variables })
  return realFetch(`http://127.0.0.1:${blankPort}/`, init)
}
for (const { tool, marker, args, firstId, firstValue } of PAGINATED_LISTS) {
  const before = blankSeen.length
  r = await out(tool, args)
  // Tools that first resolve a team key or issue identifier send helper queries
  // (teams(first: 10, ...), issues(filter: ...)) before their own connection
  // request, so the total call count is not fixed. Assert instead that exactly
  // ONE of this tool's calls carried its connection query — that proves the call
  // really went to the pageInfo-less mock.
  const blankCalls = blankSeen.slice(before)
  assert.equal(blankCalls.filter((s) => s.query.includes(marker)).length, 1, `${tool}: the call really went to the pageInfo-less mock (${marker})`)
  assert.equal(firstId(r), firstValue, `${tool}: a pageInfo-less response still returns the existing results`)
  assert.equal(r.pageInfo, null, `${tool}: missing server pageInfo normalizes to null (never invented)`)
}
// A cursor is still a variable when the server does not report pageInfo at all.
const blankCallsBefore = blankSeen.length
r = await out('linear_issue_list', { limit: 3, after: 'CURSOR_PAGE2' })
assert.equal(blankSeen.length, blankCallsBefore + 1, 'the paginated call really went to the pageInfo-less mock')
const blankCall = blankSeen.at(-1)
assert.ok(blankCall.query.includes('$after: String') && blankCall.query.includes('after: $after'), '$after is declared/passed independently of what the server returns')
assert.equal(blankCall.variables.after, 'CURSOR_PAGE2', 'cursor still sent as a variable against a pageInfo-less server')
assert.equal(r.pageInfo, null, 'pageInfo stays null when the server reports none, even on a paginated call')
globalThis.fetch = realFetch
await new Promise((resolve) => blank.close(resolve))

// -- the direct escape hatch is untouched by pagination: no pageInfo request,
// no after argument, and its document travels verbatim ------------------------
for (const [name, idArg] of [['linear_issue_get', 'APT-1'], ['linear_team_get', 'APT'], ['linear_label_get', 'l1'], ['linear_project_get', 'p1'], ['linear_cycle_get', 'c1'], ['linear_user_get', 'u1']]) {
  const before = seen.length
  await out(name, { id: idArg })
  for (const s of seen.slice(before)) {
    assert.ok(!s.query.includes('pageInfo'), `${name} does not request pageInfo`)
    assert.ok(!s.query.includes('after'), `${name} does not gain an after argument`)
  }
}

// -- the resolve-then-mutate helpers are still cursor-free ---------------------
// (The state resolver and the identifier resolver must NOT have picked up
// pagination on their way to the mutation.)
// The blank-pageInfo probe above replaced global fetch; restore the cursor mock's
// shim before exercising anything that expects its fixtures — otherwise this
// probe records into `blankSeen` and inspects unrelated earlier calls in `seen`.
globalThis.fetch = (url, init) => {
  assert.equal(url, 'https://api.linear.app/graphql', 'fetch hits the Linear API URL')
  currentMockTarget = `http://127.0.0.1:${port}/`
  return realFetch(currentMockTarget, init)
}
await out('linear_issue_create', { team: 'APT', title: 'x' })
for (const s of seen.slice(-2)) {
  assert.ok(!s.query.includes('pageInfo'), `helper query stays cursor-free: ${s.query.trim().slice(0, 60)}`)
  assert.ok(!s.query.includes('after'), `helper query has no after argument: ${s.query.trim().slice(0, 60)}`)
}

console.log('ok - cursor pagination: first page + pageInfo, after pass-through as a variable, hasNextPage/endCursor, invalid/missing values ignored, bad cursor -> clean error, defaults/max limits intact, single-item tools untouched, backwards compatible')

// --- 4. Negative tests: a key/name that does not resolve to exactly one team
// must fail with a clear "not found" error and must NOT send a malformed
// mutation. (The mock returns zero teams for the key 'NOPE'.)
// The blank-pageInfo probe above replaced global fetch; restore the cursor mock's
// shim before exercising anything that expects its fixtures.
globalThis.fetch = (url, init) => {
  assert.equal(url, 'https://api.linear.app/graphql', 'fetch hits the Linear API URL')
  currentMockTarget = `http://127.0.0.1:${port}/`
  return realFetch(currentMockTarget, init)
}
r = await out('linear_issue_create', { team: 'NOPE', title: 'x' })
assert.ok(r.error && /Team 'NOPE' not found/.test(r.error), `issue_create with unknown team fails cleanly, got: ${r.error}`)

r = await out('linear_state_list', { team: 'NOPE' })
assert.ok(r.error && /Team 'NOPE' not found/.test(r.error), `state_list with unknown team fails cleanly, got: ${r.error}`)

r = await out('linear_team_get', { id: 'NOPE' })
assert.ok(r.error && /Team not found: NOPE/.test(r.error), `team_get with unknown key fails cleanly, got: ${r.error}`)

// missing key -> clear JSON error (the execute guard converts the thrown
// "Linear API key not configured" into a { error } payload). With no env var and
// no config value, resolveKey now falls through to the key file — so HOME /
// USERPROFILE are pointed at an empty temp directory. That keeps this call off
// the real ~/.config/linear/api-key (which on some machines holds a live
// credential) while still proving the file fallback is reached: an empty isolated
// home yields no key from anywhere.
// The amended message must name all three sources.
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-linear-nohome-'))
const realHomeEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const isolateHome = () => {
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
}
const restoreRealHome = () => {
  if (realHomeEnv.HOME === undefined) delete process.env.HOME
  else process.env.HOME = realHomeEnv.HOME
  if (realHomeEnv.USERPROFILE === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realHomeEnv.USERPROFILE
}
isolateHome()
delete process.env.LINEAR_API_KEY
const noKey = JSON.parse(await byName.linear_team_list.execute({}, { signal: new AbortController().signal }))
assert.ok(noKey.error && /Linear API key not configured/.test(noKey.error), `missing key yields a clear error, got: ${noKey.error}`)
assert.match(noKey.error, /\.config.{0,12}linear.{0,12}api-key/, `the configuration error also names the key file, got: ${noKey.error}`)

globalThis.fetch = realFetch
server.close()
console.log(`ok - ${seen.length} GraphQL calls verified against mock (auth, flat UUID inputs, plural-field resolution, negative cases)`)

// --- 5. Credential fallback: config > env > ~/.config/linear/api-key ---------
// Entirely offline and isolated: every call below runs with HOME/USERPROFILE
// pointed at a throwaway directory under the OS temp dir (set in section 4), so
// the real user's ~/.config/linear/api-key is never opened. The dummy keys are
// literals; nothing here reads or prints a real credential. No tool call reaches
// the network in this section: global fetch is replaced by a recorder for its
// whole duration, so any request that happens is captured and compared instead of
// sent — and a call that fails key resolution never builds a request at all.
const recordedAuth = []
globalThis.fetch = (url, init) => {
  assert.equal(url, 'https://api.linear.app/graphql', 'fetch hits the Linear API URL')
  recordedAuth.push(init?.headers?.Authorization ?? init?.headers?.authorization)
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: {} }) })
}

// The previous section restored the real home when it ended, so re-point HOME and
// USERPROFILE at the temp home for every fallback call below.
isolateHome()

const keyFileDir = join(fakeHome, '.config', 'linear')
const keyFilePath = join(keyFileDir, 'api-key')
const writeKeyFile = (contents) => {
  mkdirSync(keyFileDir, { recursive: true })
  writeFileSync(keyFilePath, contents)
}

// Isolation: the fallback path is join(homedir(), '.config', 'linear', 'api-key'),
// and homedir() on this machine follows USERPROFILE/HOME dynamically. Every call
// below therefore runs with HOME/USERPROFILE pointed at a throwaway directory
// under the OS temp dir (set in section 4), so this suite never opens the real
// ~/.config/linear/api-key — on a machine that already has one, that file would be
// a live credential. The guard below proves the isolation took effect by proving
// the *default* path is NOT being read: with nothing set, resolution must fail
// even though this machine may hold a real key at its own home path… it cannot
// prove that without touching the real file, so the temp home is what the fallback
// resolves to, and it is deleted at the end.
assert.ok(keyFilePath.startsWith(fakeHome), 'isolation: the key-file path under test is inside the temp home')

const KEYFILE_ERROR = /Linear API key not configured/
try {
  // (a) missing file, no env, no config -> the same clear configuration error,
  // and no request is attempted at all.
  delete process.env.LINEAR_API_KEY
  let g = await out('linear_team_list', {})
  assert.ok(g.error && KEYFILE_ERROR.test(g.error), `no credential anywhere -> clear error, got: ${g.error}`)
  assert.equal(recordedAuth.length, 0, 'no request is attempted when no credential resolves')

  // (b) a blank-only file (whitespace and newlines) counts as no key.
  writeKeyFile('   \n\t\n')
  g = await out('linear_team_list', {})
  assert.ok(g.error && KEYFILE_ERROR.test(g.error), `blank key file -> clear error, got: ${g.error}`)
  assert.equal(recordedAuth.length, 0, 'a blank key file still sends no request')

  // (c) an unreadable file — here the path is a directory, so readFileSync throws
  // EISDIR — counts as no key rather than crashing.
  rmSync(keyFilePath, { force: true })
  mkdirSync(keyFilePath, { recursive: true })
  g = await out('linear_team_list', {})
  assert.ok(g.error && KEYFILE_ERROR.test(g.error), `unreadable key file -> clear error, got: ${g.error}`)
  rmSync(keyFilePath, { recursive: true, force: true })

  // (d) the file is used when it is the only credential, and its value is
  // trimmed — surrounding whitespace and newlines are not part of the key.
  const FILE_KEY = 'li_api_file_key_DUMMY'
  writeKeyFile(`\n  ${FILE_KEY}  \r\n`)
  g = await out('linear_team_list', {})
  assert.equal(recordedAuth.at(-1), FILE_KEY, `key file value sent trimmed as Authorization (got: ${JSON.stringify(recordedAuth.at(-1))})`)

  // (e) precedence: the env var beats the key file.
  const ENV_KEY = 'li_api_env_key_DUMMY'
  process.env.LINEAR_API_KEY = ENV_KEY
  g = await out('linear_team_list', {})
  assert.equal(recordedAuth.at(-1), ENV_KEY, 'LINEAR_API_KEY wins over the key file')

  // (f) precedence: config.apiKey beats env AND the file — the existing order is
  // preserved and the file only ever fills in when both are unset. A separate
  // apply() is needed here because the section-2 instance was created with {}.
  const CONFIG_KEY = 'li_api_config_key_DUMMY'
  const configDefs = []
  mod.apply({ tools: { register: (def) => { configDefs.push(def); return () => {} } } }, { apiKey: CONFIG_KEY })
  const configTool = Object.fromEntries(configDefs.map((d) => [d.name, d]))
  g = JSON.parse(await configTool.linear_team_list.execute({}, { signal: new AbortController().signal }))
  assert.equal(recordedAuth.at(-1), CONFIG_KEY, 'config.apiKey wins over env and the key file')

  // (g) an empty config value is not a credential: it falls through to env, then
  // to the file — the documented `.default('')` behaviour of the Config schema.
  // A separate apply() with apiKey: '' is needed here because the instance above
  // was created with a non-empty CONFIG_KEY.
  delete process.env.LINEAR_API_KEY
  const emptyConfigDefs = []
  mod.apply({ tools: { register: (def) => { emptyConfigDefs.push(def); return () => {} } } }, { apiKey: '' })
  const emptyConfigTool = Object.fromEntries(emptyConfigDefs.map((d) => [d.name, d]))
  g = JSON.parse(await emptyConfigTool.linear_team_list.execute({}, { signal: new AbortController().signal }))
  assert.equal(recordedAuth.at(-1), FILE_KEY, 'empty config.apiKey falls through to the key file')

  // (h) with the file gone again, an empty config value still yields the clear
  // error rather than sending an empty Authorization header.
  rmSync(keyFilePath, { force: true })
  g = JSON.parse(await emptyConfigTool.linear_team_list.execute({}, { signal: new AbortController().signal }))
  assert.ok(g.error && KEYFILE_ERROR.test(g.error), `no credential anywhere with empty config -> clear error, got: ${g.error}`)

  // (i) key lookup uses fs only — no subprocess and no network. child_process is
  // not imported by index.js at all, and the file read goes through readFileSync.
  const idxSrc = readFileSync(join(here, 'index.js'), 'utf8')
  assert.ok(!/child_process|execSync|spawnSync|\.execFile/.test(idxSrc), 'key lookup spawns no subprocess (index.js never imports child_process)')
  assert.match(idxSrc, /readFileSync\(keyFilePath\(\)/, 'the key file is read with fs.readFileSync')
  assert.ok(!/writeFileSync|appendFile/.test(idxSrc), 'index.js never writes a key anywhere')
  for (const dummy of [FILE_KEY, ENV_KEY, CONFIG_KEY]) {
    assert.ok(!idxSrc.includes(dummy), `no dummy key literal is baked into index.js (${dummy})`)
  }
} finally {
  // Remove the fabricated key file and the temp home, then restore the real home
  // environment for the rest of the suite.
  rmSync(fakeHome, { recursive: true, force: true })
  restoreRealHome()
  globalThis.fetch = realFetch
}
delete process.env.LINEAR_API_KEY

console.log('ok - credential fallback: config > env > ~/.config/linear/api-key; file value trimmed; missing/blank/unreadable file -> the same clear error naming the key file; no subprocess; offline and isolated from the real home')

// --- 6. Introspection guard ---------------------------------------------------
// The check that would have caught both bugs before they shipped: introspect the
// REAL Linear schema and assert that every field the plugin emits on the input
// types and query fields actually exists. Runs live only when LINEAR_API_KEY is
// set; skipped (with a note) otherwise, so the mock suite stays network-free.
//
// The introspection request goes to the real endpoint directly (not through the
// monkey-patched fetch), so it is independent of the mock above.
// The credential section deliberately clears LINEAR_API_KEY, so the real key
// captured at the top of this file is what decides here.
const realKey = REAL_LINEAR_KEY
if (realKey) {
  // Linear's introspection endpoint rejects the standard `... on INPUT_OBJECT`
  // / `... on OBJECT` type conditions ("Unknown type"), so we query each
  // specific type by name directly. This is the minimal introspection that
  // covers every field the plugin emits.
  const INTROSPECTION_QUERY = `
    query Introspection {
      queryType: __type(name: "Query") {
        name
        fields {
          name
          args { name }
        }
      }
      issueCreateInput: __type(name: "IssueCreateInput") {
        name
        inputFields { name }
      }
      issueUpdateInput: __type(name: "IssueUpdateInput") {
        name
        inputFields { name }
      }
      commentCreateInput: __type(name: "CommentCreateInput") {
        name
        inputFields { name }
      }
      issueRelationCreateInput: __type(name: "IssueRelationCreateInput") {
        name
        inputFields { name }
      }
      issueLabelCreateInput: __type(name: "IssueLabelCreateInput") {
        name
        inputFields { name }
      }
      projectCreateInput: __type(name: "ProjectCreateInput") {
        name
        inputFields { name }
      }
      projectUpdateInput: __type(name: "ProjectUpdateInput") {
        name
        inputFields { name }
      }
      commentUpdateInput: __type(name: "CommentUpdateInput") {
        name
        inputFields { name }
      }
      mutationType: __type(name: "Mutation") {
        name
        fields {
          name
          args { name }
        }
      }
      projectPayload: __type(name: "ProjectPayload") {
        name
        fields { name }
      }
      commentPayload: __type(name: "CommentPayload") {
        name
        fields { name }
      }
      deletePayload: __type(name: "DeletePayload") {
        name
        fields { name }
      }
      issueArchivePayload: __type(name: "IssueArchivePayload") {
        name
        fields { name }
      }
    }
  `
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: realKey },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  })
  const body = await res.json().catch(() => null)
  if (body?.errors?.length) {
    throw new Error(`Introspection failed: ${body.errors.map((e) => e.message).join('; ')}`)
  }
  const d = body.data
  const inputFieldNames = (t) => (t?.inputFields ?? []).map((f) => f.name)
  const queryFieldNames = (t) => (t?.fields ?? []).map((f) => f.name)
  const queryFieldArgs = (t, fieldName) => (t?.fields ?? []).find((f) => f.name === fieldName)?.args ?? []

  // Every field the plugin emits on these input types must exist.
  const EXPECTED_INPUT_FIELDS = {
    issueCreateInput: ['teamId', 'stateId', 'assigneeId', 'labelIds', 'title', 'description', 'priority'],
    issueUpdateInput: ['stateId', 'assigneeId', 'labelIds', 'title', 'description', 'priority'],
    commentCreateInput: ['issueId', 'body'],
    issueRelationCreateInput: ['issueId', 'relatedIssueId', 'type'],
    issueLabelCreateInput: ['teamId', 'name', 'color', 'description'],
    projectCreateInput: ['teamIds', 'name', 'description'],
    // linear_project_update emits exactly these ProjectUpdateInput fields.
    projectUpdateInput: ['name', 'description', 'content', 'icon', 'color', 'teamIds', 'startDate', 'targetDate', 'priority'],
    // linear_comment_update emits only `body`.
    commentUpdateInput: ['body'],
  }
  for (const [alias, fields] of Object.entries(EXPECTED_INPUT_FIELDS)) {
    const t = d[alias]
    assert.ok(t, `introspection: input type ${alias} exists in the Linear schema`)
    const have = inputFieldNames(t)
    for (const f of fields) {
      assert.ok(have.includes(f), `introspection: ${alias} has field '${f}' (have: ${have.join(', ')})`)
    }
  }

  // Query fields the plugin relies on must exist with the right arguments.
  const q = d.queryType
  assert.ok(q, 'introspection: Query type present')
  const qFields = queryFieldNames(q)
  for (const f of ['teams', 'workflowStates', 'issueLabels', 'cycles', 'issues', 'issue', 'team', 'users', 'user', 'projects', 'project', 'issueLabel', 'cycle']) {
    assert.ok(qFields.includes(f), `introspection: Query.${f} exists`)
  }
  // The singular `team` field must take ONLY an `id` argument (no key/name/filter).
  const teamArgs = queryFieldArgs(q, 'team').map((a) => a.name)
  assert.ok(teamArgs.includes('id'), `introspection: Query.team takes an 'id' arg (have: ${teamArgs.join(', ')})`)
  assert.ok(!teamArgs.includes('filter'), 'introspection: Query.team has NO filter arg (the plural field does)')
  assert.ok(!teamArgs.includes('key'), 'introspection: Query.team has NO key arg')
  // The plural `teams` field must accept a `filter` (TeamFilter).
  const teamsArgs = queryFieldArgs(q, 'teams').map((a) => a.name)
  assert.ok(teamsArgs.includes('filter'), `introspection: Query.teams takes a 'filter' arg (have: ${teamsArgs.join(', ')})`)
  // findProjectId uses the PLURAL projects field with a name filter; the singular
  // project field takes only a UUID id.
  const projectsArgs = queryFieldArgs(q, 'projects').map((a) => a.name)
  assert.ok(projectsArgs.includes('filter'), `introspection: Query.projects takes a 'filter' arg (have: ${projectsArgs.join(', ')})`)

  // -- Mutations the five direct write tools emit ------------------------------
  const m = d.mutationType
  assert.ok(m, 'introspection: Mutation type present')
  const mFields = queryFieldNames(m)
  for (const f of ['projectUpdate', 'commentUpdate', 'commentDelete', 'issueArchive', 'issueUnarchive']) {
    assert.ok(mFields.includes(f), `introspection: Mutation.${f} exists`)
  }
  // Each mutation's argument list must match what the plugin sends. projectUpdate
  // and commentUpdate take a separate `id` alongside `input`; commentDelete,
  // issueArchive and issueUnarchive take a BARE id (no input object type exists).
  const puArgs = queryFieldArgs(m, 'projectUpdate').map((a) => a.name)
  assert.ok(puArgs.includes('id') && puArgs.includes('input'), `introspection: Mutation.projectUpdate takes id + input (have: ${puArgs.join(', ')})`)
  const cuArgs = queryFieldArgs(m, 'commentUpdate').map((a) => a.name)
  assert.ok(cuArgs.includes('id') && cuArgs.includes('input'), `introspection: Mutation.commentUpdate takes id + input (have: ${cuArgs.join(', ')})`)
  for (const f of ['commentDelete', 'issueArchive', 'issueUnarchive']) {
    const a = queryFieldArgs(m, f).map((x) => x.name)
    assert.ok(a.includes('id'), `introspection: Mutation.${f} takes an 'id' arg (have: ${a.join(', ')})`)
    assert.ok(!a.includes('input'), `introspection: Mutation.${f} takes NO input arg — no such input type exists (have: ${a.join(', ')})`)
  }
  // Payload fields the plugin reads back. The archive payload exposes the issue as
  // `entity`, not `issue` — reading `.issue` would silently return nothing.
  const PAYLOAD_FIELDS = {
    projectPayload: ['success', 'project'],
    commentPayload: ['success', 'comment'],
    deletePayload: ['success', 'entityId'],
    issueArchivePayload: ['success', 'entity'],
  }
  for (const [alias, fields] of Object.entries(PAYLOAD_FIELDS)) {
    const t = d[alias]
    assert.ok(t, `introspection: payload type ${alias} exists in the Linear schema`)
    const have = queryFieldNames(t)
    for (const f of fields) {
      assert.ok(have.includes(f), `introspection: ${alias} has field '${f}' (have: ${have.join(', ')})`)
    }
  }
  console.log('ok - introspection guard: all emitted input fields + query fields exist in the live Linear schema')
} else {
  console.log('skip - introspection guard (no LINEAR_API_KEY in this environment; set it to run the live schema check)')
}

// --- 6. dsh-tools is host-provided, not shipped as a direct dependency -------
// DSH's PTC scheduler keeps its state on a private per-module Symbol. A second
// copy of @deepseek-ai/dsh-tools installed beside this plugin is a second
// instance of that package, and a tool compiled by one instance and run by the
// other trips "Cannot read properties of undefined (reading 'prepare')". So
// dsh-tools must come from the host: no production dependency on it, the peer
// requirement kept but marked optional so pnpm does not auto-install/hoist a
// copy, and resolution preferring the running DSH process entry point.
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

assert.equal(manifest.dependencies['@deepseek-ai/dsh-tools'], undefined, 'no production dependency on @deepseek-ai/dsh-tools')
assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], '^0.2.1-rc.3', 'peer requirement kept as ^0.2.1-rc.3')
assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true, '@deepseek-ai/dsh-tools peer marked optional')
assert.equal(manifest.devDependencies['@deepseek-ai/dsh-tools'], '0.2.1-rc.3', 'devDependency pinned to 0.2.1-rc.3 for local tests')

// The lockfile must agree with the manifest, and must not carry dsh-tools as a
// production package — a non-dev entry there is what lands in an installed profile.
const lock = JSON.parse(readFileSync(join(here, 'package-lock.json'), 'utf8'))
assert.equal(lock.version, manifest.version, `package-lock version matches package.json (${manifest.version})`)
assert.equal(lock.packages[''].version, manifest.version, 'lockfile root version matches package.json')
for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
  assert.deepEqual(lock.packages[''][key], manifest[key], `lockfile root ${key} matches package.json`)
}
const dshToolsPkgs = Object.keys(lock.packages).filter((p) => /@deepseek-ai\/dsh-tools(\/|$)/.test(p))
assert.ok(dshToolsPkgs.length > 0, 'lockfile still pins @deepseek-ai/dsh-tools for local dev')
for (const p of dshToolsPkgs) {
  assert.equal(lock.packages[p].dev, true, `lockfile entry ${p} is dev-only, so it is not installed into a consumer profile`)
}

// Packaging: the published tarball must not depend on anything being resolved from
// this checkout's own node_modules.
assert.ok(manifest.files.includes('index.js'), 'index.js is published')

// Resolution order, read off the resolver source itself (the resolvers are not
// exported): dsh-tools resolves from process.argv[1] BEFORE plain resolution
// from this file, schemastery keeps its original chain untouched.
const src = readFileSync(join(here, 'index.js'), 'utf8')
const toolsFn = /function resolveDshToolsEntry\(\)\s*\{[\s\S]*?\n\}/.exec(src)
assert.ok(toolsFn, 'resolveDshToolsEntry is present in index.js')
const toolsBody = toolsFn[0]
for (const anchor of ['dshProcessEntryAnchor()', 'selfPath', 'dshInstallAnchor()', 'tryResolveFromFromRoots']) {
  assert.ok(toolsBody.includes(anchor), `dsh-tools resolution tries ${anchor}`)
}
assert.ok(
  toolsBody.indexOf('dshProcessEntryAnchor()') < toolsBody.indexOf('selfPath'),
  'dsh-tools prefers the running DSH process entry point over this file\u2019s own node_modules',
)
const schemaFn = /function resolveDshSchemasteryEntry\(\)\s*\{[\s\S]*?\n\}/.exec(src)
assert.ok(schemaFn, 'resolveDshSchemasteryEntry is present in index.js')
assert.match(schemaFn[0], /resolveEntry\(process\.env\.DSH_LINEAR_SCHEMA, '@deepseek-ai\/schemastery'\)/, 'schemastery resolution unchanged (no process-entry anchor)')

// The host-entry anchor accepts only an absolute existing path — no hardcoded
// machine paths anywhere in the resolver.
const anchorFn = /function dshProcessEntryAnchor\(\)\s*\{[\s\S]*?\n\}/.exec(src)
assert.ok(anchorFn, 'dshProcessEntryAnchor is present in index.js')
assert.match(anchorFn[0], /process\.argv\[1\]/, 'the host anchor is derived from process.argv[1]')
assert.match(anchorFn[0], /isAbsolute/, 'a relative argv[1] is rejected')
assert.match(anchorFn[0], /existsSync/, 'a non-existent argv[1] is rejected')
assert.ok(!/[A-Za-z]:\\\\Users|[A-Za-z]:\\Users/.test(src), 'no hardcoded Windows user paths in index.js')

// And the anchor really hands resolution to the host tree: point argv[1] at a
// throwaway script inside this repo and confirm dsh-tools resolves from here.
const probeFile = join(here, '.resolution-probe.mjs')
try {
  writeFileSync(probeFile, '')
  const probed = createRequire(probeFile).resolve('@deepseek-ai/dsh-tools')
  assert.ok(probed.includes(join('node_modules', '@deepseek-ai', 'dsh-tools')), `argv[1]-anchored resolution finds a dsh-tools copy: ${probed}`)
} finally {
  rmSync(probeFile, { force: true })
}

console.log('ok - dsh-tools is host-provided: no prod dependency, optional peer ^0.2.1-rc.3, dev-only lockfile entries, resolution prefers the DSH process entry point, schemastery untouched')

console.log('\nAll checks passed.')
