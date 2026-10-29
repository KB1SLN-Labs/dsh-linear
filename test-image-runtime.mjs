import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createMcpDefinition } from './index.js'
const ctx = new Context()
new SystemPrompt(ctx, {})
const tools = new ToolRuntime(ctx, { mode: 'native' })
const services = { attachments: { saveImages: async () => [{id:'att0'}] }, llm: { resolveModelInfo: async () => ({inputModalities:['image']}) } }
const imageCtx = { get: (name) => services[name] }
const client = { request: async () => ({content:[{type:'text',text:'before'},{type:'image',mimeType:'image/png',data:'iVBORw0KGgo='}], structuredContent:{id:'x'}}) }
const def = createMcpDefinition(imageCtx, client, {}, 'linear_mcp_image', {name:'image',inputSchema:{type:'object',properties:{},additionalProperties:false}}, {})
tools.register(def)
const exec = {name:'linear_mcp_image',arguments:{},callId:'test',signal:new AbortController().signal,agent:{session:{requestHeader:()=>({config:{provider:'p',model:'m'}})},options:{provider:'p',model:'m'}}}
const result = await tools.execute(exec)
console.log(JSON.stringify(result))
assert.equal(result.isError, false)
assert.equal(result.content[0].type, 'text')
assert.equal(result.content[1].type, 'image')
assert.deepEqual(result.value.structuredContent, {id:'x'})
await ctx.fiber.dispose()
console.log('PASS real ToolRuntime image finalization')
