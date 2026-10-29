import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
const base = join(homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
const { Context } = await import(pathToFileURL(join(base,'cordis/lib/index.js')));
const { ToolRuntime, defineTool } = await import(pathToFileURL(join(base,'dsh-tools/lib/index.js')));
const { apply } = await import('./index.js');
const ctx = new Context();
ctx.provide('systemPrompt', { tools() {} });
const runtime = new ToolRuntime(ctx);
const originalRegister = runtime.register;
apply(ctx, {});
console.log('Shared registration unchanged:', runtime.register === originalRegister);
for (const name of ['edit', 'read', 'read_image']) {
  runtime.register(defineTool({ name, description:'Offline contract regression', parameters:{fail:{type:'boolean'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean'}}},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    execute({fail}) { if(fail) throw new Error('ORIGINAL ' + name + ' ERROR'); return {ok:true}; }
  }));
  for (const fail of [false,true]) {
    const result = await runtime.execute({name,arguments:{fail},callId:name+fail,signal:new AbortController().signal});
    console.log(name, fail ? 'failure' : 'success', JSON.stringify(result));
    if(fail) assert.equal(result.error?.message, 'ORIGINAL ' + name + ' ERROR');
    else assert.deepEqual(result.value,{ok:true});
  }
}
assert.equal(runtime.register, originalRegister);
console.log('PASS: Linear plugin preserves unrelated tool contracts. No API calls made.');

// Exercise the installed native edit implementation against disposable data.
const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { LocalFileSystem } = await import(pathToFileURL(join(base,'dsh-fs-local/lib/index.js')));
const { apply: registerFs } = await import(pathToFileURL(join(base,'dsh-tool-fs/lib/index.js')));
const temp = await mkdtemp(join(tmpdir(),'dsh-native-edit-'));
try {
  const nativeCtx = new Context();
  nativeCtx.provide('systemPrompt',{tools(){},section(){},getSectionOrder(){return 0;}});
  const nativeRuntime = new ToolRuntime(nativeCtx);
  new LocalFileSystem(nativeCtx,{cwd:temp,diffBasisMaxBytes:1048576});
  apply(nativeCtx,{});
  registerFs(nativeCtx,{readLimit:100,readMaxLineLength:1000,readMaxBytes:1048576,readStreamMinSize:1048576});
  const path=join(temp,'probe.txt');
  await writeFile(path,'alpha\nbeta\n');
  const edit=async(old_string,new_string)=>nativeRuntime.execute({name:'edit',arguments:{file_path:path,old_string,new_string},callId:old_string+new_string,signal:new AbortController().signal});
  const same=await edit('alpha','alpha');
  assert.equal(same.error?.message,'old_string and new_string must differ');
  assert.equal(await readFile(path,'utf8'),'alpha\nbeta\n');
  const missing=await edit('MISSING','gamma');
  assert.equal(missing.isError,true);
  assert.ok(!missing.error.message.includes('invalid output'));
  assert.equal(await readFile(path,'utf8'),'alpha\nbeta\n');
  const good=await edit('alpha','gamma');
  assert.equal(good.isError,false,JSON.stringify(good));
  assert.equal(await readFile(path,'utf8'),'gamma\nbeta\n');
  console.log('PASS: native edit rejects identical/missing matches without changing bytes; valid edit succeeds.');
} finally { await rm(temp,{recursive:true,force:true}); }
