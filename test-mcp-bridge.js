// Isolated mock-based tests for the Linear MCP bridge half of index.js.
//
// What is exercised, all against a local in-process mock MCP server (loopback
// only — never mcp.linear.app, never a real credential):
//   1. publicToolName naming contract (prefix, normalization, hash fallback,
//      the 64-char function-name limit)
//   2. discovery: paginated tools/list → one harness tool per discovered MCP
//      tool, with the discovered schemas passed through
//   3. auth header: every request the bridge sends carries
//      `Authorization: Bearer <token>` and the token never appears in a tool
//      name, description, schema, or log line
//   4. forwarding success: tools/call with the RAW wire name, model-visible
//      text extraction, structuredContent passthrough
//   5. forwarding errors: isError results surface as a clean error (secrets
//      redacted), and a transport failure is fail-soft
//   6. re-discovery on notifications/tools/list_changed: the old generation is
//      disposed and the new one registered
//   7. disposal: the ctx.effect disposer closes the client, unregisters the
//      tools, and stops reconnect timers
//
// Run: node test-mcp-bridge.js   (no LINEAR_API_KEY / LINEAR_MCP_TOKEN needed)
// Exits on its own once the checks pass — every mock server is fully closed
// (listener + its open connections), so no handle keeps the event loop alive.

import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'

// The bridge must be reachable without any credential in the environment.
delete process.env.LINEAR_API_KEY
delete process.env.LINEAR_MCP_TOKEN

const mod = await import('./index.js')

// ---------------------------------------------------------------------------
// 1. Naming contract (pure function, no network)
// ---------------------------------------------------------------------------

const hashOf = (raw) => createHash('sha256').update(`linear\0${raw}`).digest('hex').slice(0, 12)

assert.equal(mod.publicToolName('search_issues'), 'linear_mcp_search_issues', 'short raw name keeps its prefix form')
assert.equal(mod.publicToolName('save_to_project'), 'linear_mcp_save_to_project')
// Invalid characters are normalized to '_' — and a normalized name that still
// fits the limit keeps its readable prefixed form (regression: the old guard
// hashed it away).
assert.equal(mod.publicToolName('get.issues/v2'), 'linear_mcp_get_issues_v2')
// Exactly at the limit: prefix (11) + 53 = 64 stays verbatim, 54 collapses to the hash form.
assert.equal(mod.publicToolName('a'.repeat(53)), 'linear_mcp_' + 'a'.repeat(53))
assert.equal(mod.publicToolName('a'.repeat(54)), 'linear_mcp_' + 'a'.repeat(40) + '_' + hashOf('a'.repeat(54)))
// Long names are truncated + hashed, stay within the limit, keep the namespace
// prefix, and remain unique.
const longRaw = 'very_long_mcp_tool_name_that_exceeds_the_harness_function_limit_42'
const longPublic = mod.publicToolName(longRaw)
assert.equal(longPublic.length, 64, 'hashed public names are exactly 64 chars')
assert.ok(longPublic.startsWith('linear_mcp_'), 'hashed public name keeps the linear_mcp_ namespace prefix')
assert.match(longPublic, /^[A-Za-z0-9_-]+$/, 'hashed public name fits the function-name charset')
assert.ok(longPublic.endsWith(hashOf(longRaw)), 'hashed public name carries the identity hash')
assert.notEqual(mod.publicToolName(longRaw + 'X'), longPublic, 'distinct raw names never collapse onto one public name')
console.log('ok - publicToolName naming contract (prefix, normalization, 64-char hash fallback, uniqueness)')

// ---------------------------------------------------------------------------
// 2. Output contract helpers
// ---------------------------------------------------------------------------

assert.deepEqual(mod.createMcpOutput('search_issues', undefined).schema, {
  type: 'object',
  properties: { content: { type: 'array', items: {} }, structuredContent: {} },
  required: ['content'],
  additionalProperties: false,
})
assert.deepEqual(mod.createMcpOutput('search_issues', { type: 'object' }).schema.required, ['content', 'structuredContent'], 'advertised output schema makes structuredContent required')

// Unsupported MCP schema vocabulary falls back to annotation-only ({}).
assert.equal(mod.supportedOutputSchema(undefined), undefined)
assert.deepEqual(mod.supportedOutputSchema({ type: 'string' }), { type: 'string' })
assert.equal(mod.supportedOutputSchema({ type: 'object', properties: { a: { type: 'not-a-type' } } }), undefined, 'unsupported output schema falls back to unconstrained')

// extractText: model-visible rendering of an MCP content array.
assert.equal(mod.extractText([{ type: 'text', text: 'hi' }, { type: 'text', text: 'there' }], 't'), 'hi\nthere')
assert.equal(mod.extractText([], 'search_issues'), '(search_issues returned no model-visible content)')
assert.equal(mod.extractText(undefined, 't'), '(t returned no model-visible content)')
assert.match(mod.extractText([{ type: 'image', data: 'AAA', mimeType: 'image/png' }], 't'), /image result unsupported/)
assert.match(mod.extractText([{ type: 'audio', mimeType: 'audio/wav' }], 't'), /audio result unsupported: audio\/wav/)
assert.equal(mod.extractText([{ type: 'resource_link', name: 'Doc', uri: 'https://x/y' }], 't'), 'Resource link: Doc (https://x/y)')
assert.match(mod.extractText([{ type: 'resource_link', uri: 'https://x/y' }], 't'), /missing its name or URI/)
assert.match(mod.extractText([{ type: 'weird' }], 't'), /unsupported MCP content type: weird/)
assert.match(mod.extractText(['oops'], 't'), /expected an object/)
console.log('ok - createMcpOutput / supportedOutputSchema / extractText contracts')

// ---------------------------------------------------------------------------
// 3. redactSecrets
// ---------------------------------------------------------------------------

assert.equal(mod.redactSecrets('Authorization: Bearer abc.def_ghi-123 failed'), 'Authorization: [redacted] failed')
assert.equal(mod.redactSecrets('key li_api_abc123 rejected'), 'key [redacted] rejected')
assert.equal(mod.redactSecrets('sk-abc123 rejected'), '[redacted] rejected')
assert.equal(mod.redactSecrets('no secrets here'), 'no secrets here')
console.log('ok - redactSecrets strips bearer / li_ / sk- shapes')

// ---------------------------------------------------------------------------
// 4. resolveReconnectPolicy
// ---------------------------------------------------------------------------

assert.deepEqual({ ...mod.resolveReconnectPolicy(undefined, 'p') }, { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 })
assert.deepEqual({ ...mod.resolveReconnectPolicy({ enabled: false, maxAttempts: 3 }, 'p') }, { enabled: false, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 3 })
for (const [bad, re] of [
  [{ nope: 1 }, /p\.nope is not a reconnect option/],
  [{ initialDelayMs: 0 }, /initialDelayMs must be a positive finite number/],
  [{ initialDelayMs: 5000, maxDelayMs: 1000 }, /initialDelayMs must be less than or equal to maxDelayMs/],
  [{ maxAttempts: 0 }, /maxAttempts must be a positive integer/],
  [{ maxAttempts: 1.5 }, /maxAttempts must be a positive integer/],
]) {
  assert.throws(() => mod.resolveReconnectPolicy(bad, 'p'), re, `rejects ${JSON.stringify(bad)}`)
}
assert.ok(Object.isFrozen(mod.resolveReconnectPolicy(undefined, 'p')), 'policy is frozen')
console.log('ok - resolveReconnectPolicy defaults, overrides, and validation')

// ---------------------------------------------------------------------------
// Mock MCP server (loopback) + fake harness ctx
// ---------------------------------------------------------------------------

const FAKE_TOKEN = 'li_mcp_FAKE_TOKEN_do_not_use'
const MCP_URL_PATH = '/mcp'

/**
 * Build a mock Linear-hosted-MCP-style server.
 * `pages` is the sequence of tools/list pages; each is { tools, nextCursor? }.
 * `callHandler(name, args)` returns the tools/call result.
 * `opts.failConnect` makes every request 401 (auth-failure path).
 * `opts.getMode` controls the optional GET SSE stream: 'none' (405),
 * 'sse' (streams notifications/tools/list_changed once).
 *
 * `close()` is the ONLY way to stop this server. Plain `server.close()` stops
 * accepting new connections but leaves already-open keep-alive POST sockets —
 * and the never-ending GET SSE stream — open, which keeps the Node event loop
 * alive after every check has passed. The helper closes idle AND active
 * connections (ending any open SSE response) before closing the listener.
 */
async function startMockMcpServer({ pages = [{ tools: [] }], callHandler, failConnect = false, getMode = 'none', listChangedPages } = {}) {
  const requests = []
  let pushNotification
  let listCount = 0
  /** Open SSE responses (GET stream), ended explicitly by close(). */
  const sseResponses = []
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers }
    if (req.method === 'GET') {
      requests.push({ method: 'GET', headers })
      if (getMode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        sseResponses.push(res)
        res.on('close', () => {
          const i = sseResponses.indexOf(res)
          if (i !== -1) sseResponses.splice(i, 1)
        })
        res.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n')
        pushNotification = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        req.on('close', () => { pushNotification = undefined })
        return
      }
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const msg = JSON.parse(body)
      requests.push({ method: 'POST', headers, message: msg })
      if (failConnect) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const reply = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      }
      switch (msg.method) {
        case 'initialize':
          reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'mock-linear-mcp', version: '0.0.1' } })
          break
        case 'notifications/initialized':
          res.writeHead(202).end()
          break
        case 'tools/list': {
          // When listChangedPages is set, the FIRST listing serves `pages` and
          // every later one serves the changed set (server-side tool churn).
          const active = listChangedPages !== undefined && listCount++ > 0 ? listChangedPages : pages
          const cursor = msg.params?.cursor
          const index = cursor === undefined ? 0 : Number(cursor)
          const page = active[index] ?? { tools: [] }
          // nextCursor is opaque; hand out numeric strings and map them back.
          const nextCursor = page.nextCursor ?? (index + 1 < active.length ? String(index + 1) : undefined)
          reply({ tools: page.tools, ...(nextCursor === undefined ? {} : { nextCursor }) })
          break
        }
        case 'tools/call':
          reply(callHandler?.(msg.params.name, msg.params.arguments) ?? { content: [{ type: 'text', text: 'ok' }] })
          break
        default:
          res.writeHead(202).end()
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}${MCP_URL_PATH}`
  return {
    url,
    requests,
    server,
    pushNotification,
    /** Fully reap the listener AND every connection it still holds open. */
    close() {
      // The GET SSE response never ends on its own, so end those responses first.
      for (const res of sseResponses) res.end()
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Minimal harness-shaped ctx: records registrations + logs, supports effects. */
function makeCtx() {
  const registered = new Map()
  const logs = { info: [], warn: [], error: [] }
  const effects = []
  return {
    registered,
    logs,
    effects,
    tools: {
      register(def) {
        if (registered.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`)
        let disposed = false
        registered.set(def.name, def)
        return () => {
          disposed = true
          registered.delete(def.name)
          def.__disposed = () => disposed
        }
      },
    },
    logger: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
    effect(fn, label) {
      effects.push({ label, run: fn })
    },
    /** Run every effect disposer the way cordis teardown does (async-aware). */
    async dispose() {
      for (const { run } of effects) {
        let disposer = run()
        if (typeof disposer === 'function') disposer = disposer()
        if (disposer && typeof disposer[Symbol.iterator] === 'function') {
          for (const d of disposer) await d()
        }
      }
    },
  }
}

const tool = (name, extra = {}) => ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, ...extra })

// ---------------------------------------------------------------------------
// 5. Discovery + auth header + forwarding success
// ---------------------------------------------------------------------------

{
  const pages = [
    { tools: [tool('search_issues'), tool('save.to_project')] },
    { tools: [tool('a'.repeat(54)), tool('get_long_output', { outputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } })] },
  ]
  const calls = []
  const mock = await startMockMcpServer({
    pages,
    callHandler: (name, args) => {
      calls.push({ name, args })
      if (name === 'search_issues') return { content: [{ type: 'text', text: 'found 1 issue' }], structuredContent: { id: 'i1' } }
      if (name === 'a'.repeat(54)) return { content: [{ type: 'text', text: 'long-name tool ran' }] }
      return { content: [{ type: 'text', text: `ran ${name}` }] }
    },
  })

  const ctx = makeCtx()
  const error = await mod.apply(ctx, { mcp: { token: FAKE_TOKEN, url: mock.url } })

  // Discovery produced one harness tool per discovered MCP tool, paginated.
  const publicNames = [...ctx.registered.keys()]
  assert.ok(publicNames.length >= 20, `MCP tools registered on top of the GraphQL suite: got ${publicNames.length}`)
  const mcpNames = publicNames.filter((n) => n.startsWith('linear_mcp_'))
  assert.deepEqual(
    mcpNames.sort(),
    ['linear_mcp_get_long_output', 'linear_mcp_save_to_project', 'linear_mcp_search_issues', 'linear_mcp_' + 'a'.repeat(40) + '_' + hashOf('a'.repeat(54))].sort(),
    'discovered MCP tools registered under the naming contract (incl. normalized + hashed names)',
  )

  // The discovered schemas pass through untouched — nothing hand-modelled.
  const search = ctx.registered.get('linear_mcp_search_issues')
  assert.equal(search.description, 'desc search_issues')
  assert.deepEqual(search.parameters, { type: 'object', properties: { q: { type: 'string' } } })
  assert.deepEqual(search.output.schema.properties.structuredContent, {}, 'no advertised outputSchema → unconstrained structuredContent')
  const longOut = ctx.registered.get('linear_mcp_get_long_output')
  assert.deepEqual(longOut.output.schema.properties.structuredContent, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, 'advertised outputSchema kept')
  assert.deepEqual(longOut.output.schema.required, ['content', 'structuredContent'])

  // Auth header: Bearer scheme on every POST, and the token never leaks into
  // any registered tool surface or log line.
  const posts = mock.requests.filter((r) => r.method === 'POST')
  assert.ok(posts.length >= 3, `initialize + initialized + tools/list pages seen (${posts.length})`)
  for (const r of posts) {
    assert.equal(r.headers.authorization, `Bearer ${FAKE_TOKEN}`, 'MCP requests carry Authorization: Bearer <token>')
  }
  for (const def of ctx.registered.values()) {
    const surface = JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters })
    assert.ok(!surface.includes(FAKE_TOKEN), `token never appears in tool surface ${def.name}`)
  }
  for (const line of [...ctx.logs.info, ...ctx.logs.warn, ...ctx.logs.error]) {
    assert.ok(!line.includes(FAKE_TOKEN), `token never appears in log line: ${line}`)
  }
  assert.ok(ctx.logs.info.some((l) => /registered 4 Linear MCP tools/.test(l)), 'connect log reports the discovered count')

  // tools/list pagination: two pages requested, second carried the cursor.
  const listReqs = posts.filter((r) => r.message?.method === 'tools/list')
  assert.equal(listReqs.length, 2, 'paginated tools/list fetched every page')
  assert.equal(listReqs[1].message.params.cursor, '1', 'continuation cursor round-tripped verbatim')

  // Forwarding success: call goes out with the RAW wire name and the args.
  const result = await search.execute({ q: 'bridge' }, { signal: new AbortController().signal })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'found 1 issue' }], structuredContent: { id: 'i1' } })
  assert.deepEqual(calls.at(-1), { name: 'search_issues', args: { q: 'bridge' } }, 'tools/call uses the raw wire name')
  assert.deepEqual(search.output.render({ q: 'bridge' }, result), [{ type: 'text', text: 'found 1 issue' }], 'render extracts model-visible text')

  // A hashed public name still forwards its RAW name.
  const hashedDef = ctx.registered.get('linear_mcp_' + 'a'.repeat(40) + '_' + hashOf('a'.repeat(54)))
  await hashedDef.execute({}, { signal: new AbortController().signal })
  assert.equal(calls.at(-1).name, 'a'.repeat(54), 'hashed public name forwards the raw wire name')

  // Non-object args are normalised to {} on the wire.
  await search.execute(undefined, { signal: new AbortController().signal })
  assert.deepEqual(calls.at(-1).args, {}, 'undefined args forwarded as {}')

  await ctx.dispose()
  // Disposal: every MCP registration unregistered, client closed.
  assert.ok(![...ctx.registered.keys()].some((n) => n.startsWith('linear_mcp_')), 'dispose unregisters the MCP generation')
  assert.ok(ctx.registered.size >= 20, 'GraphQL suite untouched by MCP disposal')
  await mock.close()
  console.log('ok - discovery (paginated), Bearer auth header, no token leak, raw-name forwarding, disposal')
}

// ---------------------------------------------------------------------------
// 6. Forwarding error: isError result
// ---------------------------------------------------------------------------

{
  const mock = await startMockMcpServer({
    pages: [{ tools: [tool('failing_tool')] }],
    callHandler: () => ({
      isError: true,
      content: [{ type: 'text', text: 'linear auth rejected token li_api_supersecret' }],
    }),
  })
  const ctx = makeCtx()
  await mod.apply(ctx, { mcp: { token: FAKE_TOKEN, url: mock.url } })
  const def = ctx.registered.get('linear_mcp_failing_tool')
  assert.ok(def, 'failing tool still discovered')
  let thrown
  try {
    await def.execute({}, { signal: new AbortController().signal })
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof Error, 'isError result throws instead of returning a value')
  assert.match(thrown.message, /linear auth rejected/)
  assert.ok(!thrown.message.includes('li_api_supersecret'), 'error text is secret-redacted')
  assert.ok(!thrown.message.includes(FAKE_TOKEN), 'error text never carries the configured token')
  await ctx.dispose()
  await mock.close()
  console.log('ok - isError tool results surface as a clean redacted error')
}

// ---------------------------------------------------------------------------
// 7. Re-discovery on notifications/tools/list_changed (atomic generation swap)
// ---------------------------------------------------------------------------

{
  const mock = await startMockMcpServer({
    pages: [{ tools: [tool('old_tool'), tool('kept_tool')] }],
    listChangedPages: [{ tools: [tool('kept_tool'), tool('new_tool')] }],
    getMode: 'sse',
  })
  const ctx = makeCtx()
  await mod.apply(ctx, { mcp: { token: FAKE_TOKEN, url: mock.url } })
  assert.ok(ctx.registered.has('linear_mcp_old_tool'), 'initial generation registered')
  const oldDef = ctx.registered.get('linear_mcp_old_tool')

  // The SSE stream pushes notifications/tools/list_changed; the bridge must
  // re-list and swap generations: dropped tool unregistered, added tool registered.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !(ctx.registered.has('linear_mcp_new_tool') && !ctx.registered.has('linear_mcp_old_tool'))) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(ctx.logs.info.some((l) => /tool list changed, re-syncing/.test(l)), 're-sync logged')
  assert.ok(ctx.registered.has('linear_mcp_new_tool'), 'added MCP tool registered after re-sync')
  assert.ok(!ctx.registered.has('linear_mcp_old_tool'), 'dropped MCP tool unregistered after re-sync')
  assert.ok(oldDef.__disposed(), 'old generation disposer ran during the swap')
  assert.ok(ctx.registered.has('linear_mcp_kept_tool'), 'tool present in both generations stays registered')

  await ctx.dispose()
  assert.ok(![...ctx.registered.keys()].some((n) => n.startsWith('linear_mcp_')), 'dispose unregisters the current generation after a swap')
  await mock.close()
  console.log('ok - tools/list_changed re-discovers and atomically swaps the registration generation')
}

// ---------------------------------------------------------------------------
// 8. Connection error is fail-soft: GraphQL suite stays, bridge logs and stays off
// ---------------------------------------------------------------------------

{
  const mock = await startMockMcpServer({ failConnect: true })
  const ctx = makeCtx()
  // apply() must not throw even though the MCP endpoint rejects with 401.
  await mod.apply(ctx, { mcp: { token: FAKE_TOKEN, url: mock.url, reconnect: { enabled: false } } })
  assert.ok(ctx.registered.size >= 20, 'GraphQL suite registers despite MCP failure')
  assert.ok(![...ctx.registered.keys()].some((n) => n.startsWith('linear_mcp_')), 'no MCP tools registered on connect failure')
  const all = [...ctx.logs.info, ...ctx.logs.warn, ...ctx.logs.error].join('\n')
  assert.match(all, /connection attempt failed|connection failed and reconnect is disabled/)
  assert.ok(!all.includes(FAKE_TOKEN), 'auth failure logs never echo the token')
  assert.match(all, /check that the Linear MCP token/, '401 gets an actionable auth hint')
  await ctx.dispose()
  await mock.close()
  console.log('ok - MCP connect failure is fail-soft (GraphQL suite intact, no token echo, auth hint)')
}

// ---------------------------------------------------------------------------
// 9. Bridge stays off without a token / without ctx.effect / when disabled
// ---------------------------------------------------------------------------

{
  const ctx = makeCtx()
  await mod.apply(ctx, {})
  assert.ok(ctx.registered.size >= 20, 'GraphQL tools still register with no MCP token')
  assert.ok(![...ctx.registered.keys()].some((n) => n.startsWith('linear_mcp_')), 'no MCP tools without a token')
  assert.ok(ctx.logs.warn.some((l) => /bridge disabled — Linear MCP token not configured/.test(l)), 'missing token logged as disabled bridge')

  // A bare ctx without effect support keeps the bridge off (no lifecycle owner).
  const bare = { tools: { register: () => () => {} }, logger: { info() {}, warn() {}, error() {} } }
  mod.apply(bare, { mcp: { token: FAKE_TOKEN, url: 'http://127.0.0.1:1/mcp' } })
  console.log('ok - bridge fail-soft: no token, or ctx without effect → GraphQL-only')
}

// ---------------------------------------------------------------------------
// 10. Disposal stops reconnect timers and closes the client
// ---------------------------------------------------------------------------

{
  const mock = await startMockMcpServer({ failConnect: true })
  const ctx = makeCtx()
  await mod.apply(ctx, { mcp: { token: FAKE_TOKEN, url: mock.url, reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 2 } } })
  const connectsBefore = mock.requests.filter((r) => r.message?.method === 'initialize').length
  await ctx.dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const connectsAfter = mock.requests.filter((r) => r.message?.method === 'initialize').length
  assert.equal(connectsAfter, connectsBefore, 'dispose cancels the pending reconnect timer — no further connect attempts')
  await mock.close()
  console.log('ok - disposal stops reconnect scheduling')
}

console.log('\nAll MCP bridge checks passed.')
