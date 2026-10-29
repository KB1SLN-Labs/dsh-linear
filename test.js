// Self-check for @kb1slnlabs/dsh-linear: verifies the module surface, the
// defineTool registrations (20 tools), and the GraphQL client against a mock
// server that mirrors the REAL Linear schema (flat UUID input fields, plural
// `teams`/`workflowStates`/`issueLabels`/`cycles` query fields).
//
// Run: node test.js   (no network for the mock suite; the introspection guard
// below runs live against the real Linear API only when LINEAR_API_KEY is set,
// and is skipped otherwise.)

import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

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
  'linear_comment_add',
  'linear_comment_list',
  'linear_relation_add',
  'linear_team_list',
  'linear_state_list',
  'linear_label_list',
  'linear_project_list',
  'linear_project_create',
  'linear_label_create',
  'linear_cycle_list',
  'linear_cycle_get',
  'linear_user_list',
  'linear_user_get',
  'linear_project_get',
  'linear_label_get',
  'linear_team_get',
]
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
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    seen.push({
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
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
      res.end(JSON.stringify({ data: { workflowStates: { nodes: [{ id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Todo', type: 'unstarted', position: 0 }, { id: 'cccccccc-1111-2222-3333-444444444444', name: 'In Progress', type: 'started', position: 1 }] } } }))
    } else if (q.includes('issueLabels(filter: { team: { id: { eq: $teamId } } }')) {
      res.end(JSON.stringify({ data: { issueLabels: { nodes: [{ id: 'l1', name: 'bug', color: '#f00', description: '' }] } } }))
    } else if (q.includes('cycles(first')) {
      res.end(JSON.stringify({ data: { cycles: { nodes: [{ id: 'c1', number: 1, name: 'Cycle 1', startsAt: '2024-01-01', endsAt: '2024-01-14', completedAt: '2024-01-14', progress: 0.5, team: { id: 't1', name: 'APT', key: 'APT' } }] } } }))
    } else if (q.includes('teams(first: 10, filter: { key: { eq: $v } }')) {
      if (v.v === 'NOPE') res.end(JSON.stringify({ data: { teams: { nodes: [] } } }))
      else res.end(JSON.stringify({ data: { teams: { nodes: [{ id: '12345678-1234-1234-1234-123456789abc', name: 'APT', key: 'APT', description: 'd' }] } } }))
    } else if (q.includes('teams(first: 10, filter: { key: { eq: $key } }')) {
      if (v.key === 'NOPE') res.end(JSON.stringify({ data: { teams: { nodes: [] } } }))
      else res.end(JSON.stringify({ data: { teams: { nodes: [{ id: '12345678-1234-1234-1234-123456789abc', name: 'APT', key: 'APT', description: 'd' }] } } }))
    } else if (q.includes('teams(first: 100)')) {
      res.end(JSON.stringify({ data: { teams: { nodes: [{ id: '12345678-1234-1234-1234-123456789abc', name: 'APT', key: 'APT', description: 'd' }] } } }))
    } else if (q.includes('issues(filter: { team')) {
      res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'dddddddd-1111-2222-3333-444444444444' }] } } }))
    } else if (q.includes('issues(first')) {
      res.end(JSON.stringify({ data: { issues: { nodes: [{ id: 'i1', identifier: 'APT-1', title: 'T', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'https://linear.app/x/issue/APT-1' }] } } }))
    } else if (q.includes('issue: issue(id: $id) { id team { id } }')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', team: { id: 't1' } } } }))
    } else if (q.includes('comments(first')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', comments: { nodes: [{ id: 'c1', body: 'hello', createdAt: 'now' }] } } } }))
    } else if (q.includes('issue: issue(id: $id)')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', identifier: 'APT-1', title: 'T', description: 'D', state: { name: 'Todo' }, assignee: null, priority: 0, labels: { nodes: [] }, project: null, url: 'u', relations: { nodes: [] } } } }))
    } else if (q.includes('comments(')) {
      res.end(JSON.stringify({ data: { issue: { id: 'i1', comments: { nodes: [{ id: 'c1', body: 'hello', createdAt: 'now' }] } } } }))
    } else if (q.includes('issueCreate')) {
      res.end(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: 'i2', identifier: 'APT-2', title: 'new', state: { name: 'Backlog' }, url: 'u2' } } } }))
    } else if (q.includes('issueUpdate')) {
      res.end(JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: 'i1', identifier: 'APT-1', title: 'T', state: { name: 'Done' }, assignee: null, url: 'u' } } } }))
    } else if (q.includes('commentCreate')) {
      res.end(JSON.stringify({ data: { commentCreate: { success: true, comment: { id: 'c1', body: 'hello', createdAt: 'now' } } } }))
    } else if (q.includes('issueRelationCreate')) {
      res.end(JSON.stringify({ data: { issueRelationCreate: { success: true, relation: { id: 'r1' } } } }))
    } else if (q.includes('projects(')) {
      res.end(JSON.stringify({ data: { projects: { nodes: [{ id: 'p1', name: 'P', description: '', state: 'started', teams: [{ id: 't1', name: 'APT', key: 'APT' }] }] } } }))
    } else if (q.includes('projectCreate')) {
      res.end(JSON.stringify({ data: { projectCreate: { success: true, project: { id: 'p2', name: 'NP', description: '', state: 'started', teams: [] } } } }))
    } else if (q.includes('issueLabelCreate')) {
      res.end(JSON.stringify({ data: { issueLabelCreate: { success: true, label: { id: 'l2', name: 'feat', color: '#0f0', description: '' } } } }))
    } else if (q.includes('cycle: cycle(id: $id)')) {
      res.end(JSON.stringify({ data: { cycle: { id: 'c1', number: 1, name: 'Cycle 1', startsAt: '2024-01-01', endsAt: '2024-01-14', completedAt: '2024-01-14', progress: 0.5, team: { id: 't1', name: 'APT', key: 'APT' } } } }))
    } else if (q.includes('users(first')) {
      res.end(JSON.stringify({ data: { users: { nodes: [{ id: 'u1', name: 'Alice', displayName: 'Alice A', email: 'alice@example.com', active: true }] } } }))
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
    } else {
      res.end(JSON.stringify({ data: {} }))
    }
  })
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port

// Point the plugin's client at the mock by monkey-patching global fetch.
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) => {
  assert.equal(url, 'https://api.linear.app/graphql', 'fetch hits the Linear API URL')
  return realFetch(`http://127.0.0.1:${port}/`, init)
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

// comment_add — flat issueId
r = await out('linear_comment_add', { issue: 'APT-1', body: 'hello' })
assert.equal(r.body, 'hello')
assert.ok(UUID_RE.test(seen.at(-1).variables.input.issueId), 'commentCreate input.issueId is a UUID')
assert.ok(!('issue' in seen.at(-1).variables.input), 'commentCreate input has NO nested issue object')

// comment_list
r = await out('linear_comment_list', { issue: 'APT-1' })
assert.equal(r.count, 1)

// relation_add — flat issueId/relatedId
r = await out('linear_relation_add', { issue: 'APT-1', related: '12345678-1234-1234-1234-123456789abc' })
assert.equal(r.ok, true)
assert.ok(UUID_RE.test(seen.at(-1).variables.input.issueId), 'issueRelationCreate input.issueId is a UUID')
assert.ok(UUID_RE.test(seen.at(-1).variables.input.relatedIssueId), 'issueRelationCreate input.relatedIssueId is a UUID')
assert.ok(!('issue' in seen.at(-1).variables.input), 'issueRelationCreate input has NO nested issue object')

// team_list
r = await out('linear_team_list')
assert.equal(r.teams[0].key, 'APT')

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

// auth header on every call (raw key, no Bearer prefix — Linear requirement)
for (const s of seen) {
  assert.equal(s.auth, 'li_api_test', 'raw API key sent as Authorization (no Bearer)')
  assert.equal(s.contentType, 'application/json')
}

// --- 4. Negative tests: a key/name that does not resolve to exactly one team
// must fail with a clear "not found" error and must NOT send a malformed
// mutation. (The mock returns zero teams for the key 'NOPE'.)
r = await out('linear_issue_create', { team: 'NOPE', title: 'x' })
assert.ok(r.error && /Team 'NOPE' not found/.test(r.error), `issue_create with unknown team fails cleanly, got: ${r.error}`)

r = await out('linear_state_list', { team: 'NOPE' })
assert.ok(r.error && /Team 'NOPE' not found/.test(r.error), `state_list with unknown team fails cleanly, got: ${r.error}`)

r = await out('linear_team_get', { id: 'NOPE' })
assert.ok(r.error && /Team not found: NOPE/.test(r.error), `team_get with unknown key fails cleanly, got: ${r.error}`)

// missing key -> clear JSON error (the execute guard converts the thrown
// "Linear API key not configured" into a { error } payload)
delete process.env.LINEAR_API_KEY
const noKey = JSON.parse(await byName.linear_team_list.execute({}, { signal: new AbortController().signal }))
assert.ok(noKey.error && /Linear API key not configured/.test(noKey.error), `missing key yields a clear error, got: ${noKey.error}`)

globalThis.fetch = realFetch
server.close()
console.log(`ok - ${seen.length} GraphQL calls verified against mock (auth, flat UUID inputs, plural-field resolution, negative cases)`)

// --- 5. Introspection guard ---------------------------------------------------
// The check that would have caught both bugs before they shipped: introspect the
// REAL Linear schema and assert that every field the plugin emits on the input
// types and query fields actually exists. Runs live only when LINEAR_API_KEY is
// set; skipped (with a note) otherwise, so the mock suite stays network-free.
//
// The introspection request goes to the real endpoint directly (not through the
// monkey-patched fetch), so it is independent of the mock above.
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
  console.log('ok - introspection guard: all emitted input fields + query fields exist in the live Linear schema')
} else {
  console.log('skip - introspection guard (no LINEAR_API_KEY in this environment; set it to run the live schema check)')
}

console.log('\nAll checks passed.')
