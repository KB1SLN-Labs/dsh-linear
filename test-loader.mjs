// test-loader.mjs — offline smoke test: load @kb1slnlabs/dsh-linear through the
// Cordis plugin loader against the scratch profile, and assert the entry started
// with a fiber and wired 20 tools into the real host ToolRuntime, and that those
// names are gone after the plugin fiber is disposed. No keys, no network.
//
// Run: DSH_ROOT=<dsh install dir> LINEAR_TEST_PROFILE=<profile dir> node test-loader.mjs
// The 15-second step deadline below only checks progress between phases; it is not a
// hard timeout and cannot interrupt an async call that never settles.
// Both variables are required; see README "Testing".

import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEADLINE = Date.now() + 15_000;
function step(label) {
  const left = DEADLINE - Date.now();
  if (left <= 0) throw new Error(`15 second bound exceeded at: ${label}`);
  return left;
}

// Required environment, validated up front so a missing or malformed value
// fails with an actionable message instead of an import error:
//   DSH_ROOT            the dsh installation directory (the directory holding
//                       node_modules/@deepseek-ai/cordis), absolute
//   LINEAR_TEST_PROFILE the scratch profile directory to load against, given
//                       either as an absolute filesystem path or as a file: URL
function requireDir(name, value) {
  if (!value || !value.trim()) {
    throw new Error(`${name} is required: set it to an absolute directory path (LINEAR_TEST_PROFILE also accepts a file: URL)`);
  }
  return value.trim();
}

// A filesystem path becomes a directory URL through pathToFileURL, which handles
// Windows drive letters, UNC roots, spaces and other characters that need
// Percent-encoded; a hand-built `file:///` string would not. The trailing slash
// marks it as a directory so relative specifiers resolve against it. A Windows
// drive letter (`C:/…`) is a path, not a scheme — the scheme test excludes a
// one-letter prefix so absolute drive paths are not mistaken for URLs.
function toDirectoryUrl(name, value) {
  const text = value.trim();
  let url;
  if (/^file:\/\//i.test(text)) url = new URL(/\/$/.test(text) ? text : `${text}/`);
  else if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(text)) throw new Error(`${name} must be an absolute filesystem path or a file: URL, got ${JSON.stringify(value)}`);
  else url = pathToFileURL(/[/\\]$/.test(text) ? text : `${text}/`);
  if (!existsSync(fileURLToPath(url))) throw new Error(`${name} does not exist: ${fileURLToPath(url)}`);
  return url;
}

step('environment');
const DSH_ROOT = toDirectoryUrl('DSH_ROOT', requireDir('DSH_ROOT', process.env.DSH_ROOT));
const SCRATCH_PROFILE = toDirectoryUrl('LINEAR_TEST_PROFILE', requireDir('LINEAR_TEST_PROFILE', process.env.LINEAR_TEST_PROFILE));
const NODE_MODULES = new URL('node_modules/@deepseek-ai/', DSH_ROOT);

const EXPECTED_TOOL_NAMES = [
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
];

// Keep the plugin offline: no live key can be picked up from the environment.
delete process.env.LINEAR_API_KEY;
delete process.env.LINEAR_MCP_TOKEN;
delete process.env.LINEAR_APIKEY;
delete process.env.LINEAR_KEY;

const CORDIS_URL = new URL('cordis/lib/index.js', NODE_MODULES).href;
const LOADER_URL = new URL('cordis-plugin-loader/lib/index.js', NODE_MODULES).href;

step('imports');
const { Context } = await import(CORDIS_URL);
const Loader = (await import(LOADER_URL)).default;
// Real host services, resolved from DSH_ROOT — no fixture stand-in for `tools`.
const { SystemPrompt } = await import(new URL('dsh-system-prompt/lib/index.js', NODE_MODULES).href);
const { ToolRuntime } = await import(new URL('dsh-tools/lib/index.js', NODE_MODULES).href);

step('context');
const ctx = new Context();
ctx.baseUrl = SCRATCH_PROFILE;

new SystemPrompt(ctx, {});
const tools = new ToolRuntime(ctx, { mode: 'native' });

step('loader plugin');
const loaderFiber = ctx.plugin(Loader);
await loaderFiber;
if (!ctx.loader) throw new Error('loader service not available after ctx.plugin(Loader)');

step('loader.create');
await ctx.loader.create({ id: 'linear', name: '@kb1slnlabs/dsh-linear', config: {} });

step('assertions');
const entry = ctx.loader.resolve('linear');
if (!entry) throw new Error('loader entry "linear" not found');
if (!entry.fiber) throw new Error('loader entry "linear" has no fiber');

// Before disposal: the real ToolRuntime must know exactly the 20 linear tools.
const wired = tools.wireSchemas({});
const registered = wired.knownNames.slice();
const missing = EXPECTED_TOOL_NAMES.filter((name) => !registered.includes(name));
const extra = registered.filter((name) => !EXPECTED_TOOL_NAMES.includes(name));

console.log(`entry id:      ${entry.id}`);
console.log(`entry name:    ${entry.options.name}`);
console.log(`fiber uid:     ${entry.fiber.uid}`);
console.log(`fiber state:   ${entry.fiber.state}`);
console.log(`wire schemas:  ${Object.keys(wired.schemas).length}`);
console.log(`knownNames:    ${registered.length}`);
console.log(`names:         ${JSON.stringify(registered)}`);
if (missing.length) console.log(`missing:       ${JSON.stringify(missing)}`);
if (extra.length) console.log(`unexpected:    ${JSON.stringify(extra)}`);

let failed = false;
if (wired.schemas == null || typeof wired.schemas !== 'object') {
  console.error('FAIL: wireSchemas({}) did not return a schemas object');
  failed = true;
}
if (registered.length !== 20) {
  console.error(`FAIL: expected 20 knownNames before disposal, got ${registered.length}`);
  failed = true;
}
if (missing.length) {
  console.error(`FAIL: ${missing.length} expected tool name(s) not known to ToolRuntime`);
  failed = true;
}

step('dispose');
// Dispose the plugin fiber first so its effects (the tool registrations) are
// torn down while the `tools` service is still live, then tear down the whole
// context. After disposal the runtime must know none of the linear tools.
const entryFiber = entry.fiber;
await entryFiber.dispose();
const afterDispose = tools.wireSchemas({});
const remaining = afterDispose.knownNames.filter((name) => EXPECTED_TOOL_NAMES.includes(name));
console.log(`knownNames after dispose: ${afterDispose.knownNames.length}`);
console.log(`schemas after dispose:    ${Object.keys(afterDispose.schemas).length}`);
if (remaining.length) {
  console.log(`still known:   ${JSON.stringify(remaining)}`);
  console.error(`FAIL: ${remaining.length} linear tool(s) still known to ToolRuntime after disposal`);
  failed = true;
}
await ctx.fiber.dispose();

if (failed) process.exitCode = 1;
else console.log('PASS: loader entry has a fiber, 20 tool names wired before disposal and none after');
