import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createMcpExtension } from '../src/index.ts';
import type { McpExtensionOptions, McpServerSpec, McpToolCallInfo } from '../src/index.ts';

// urlcode#678: handlers are called as handler(args, context) with the mount route's granted env,
// the request id the response carries and the server/tool names; onToolCall observes every
// handler invocation's outcome and a throwing onToolCall never changes the response.
const origin = 'https://mcp-context.example.test';
const record = 'export default function (input, context) { return { input, context: { ...context, env: { ...context.env } }, frozen: Object.isFrozen(context) }; }\n';

async function boot(t: test.TestContext, options: Omit<McpExtensionOptions, 'projectSha256'> = {}, grant = true) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-context-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'app'); await mkdir(dir);
  await writeFile(join(dir, 'record.mjs'), record);
  await writeFile(join(dir, 'boom.mjs'), 'export default function () { throw new Error("internal detail"); }\n');
  await writeFile(join(dir, 'text.mjs'), 'export default function (_input, context) { return `resource for ${context.requestId}`; }\n');
  await writeFile(join(dir, 'prompt.mjs'), 'export default function (_input, context) { return `${context.kind}:${context.tool}:${context.env.SKILLS}`; }\n');
  const spec: McpServerSpec = {
    mount: '/mcp', serverName: 'ctx', serverVersion: '1.0.0',
    tools: {
      record: { description: 'Returns its context', inputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 20 } }, additionalProperties: false }, handler: './record.mjs' },
      boom: { description: 'Throws', inputSchema: { type: 'object', additionalProperties: false }, handler: './boom.mjs' },
    },
    resources: { readme: { uri: 'test://readme', name: 'readme', handler: './text.mjs' } },
    prompts: { hello: { handler: './prompt.mjs' } },
  };
  await writeFile(join(dir, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { mcp: { version: '1', config: { servers: { main: spec } } } },
    routes: { '/mcp/*': { extension: 'mcp', methods: ['POST', 'HEAD'], env: { SKILLS: { env: 'MCP_ENABLED_SKILLS' }, REGION: { value: 'eu-west-1' } } } } }));
  const projectSha256 = await inspectExtensionRevision(dir);
  const permissions = grant ? { version: 1 as const, projectSha256, routes: { '/mcp/*': { env: ['MCP_ENABLED_SKILLS'] } } } : undefined;
  const app = await startServer({ project: dir, origin, port: 0, log: () => {}, environment: { MCP_ENABLED_SKILLS: 'alpha,beta' }, ...(permissions ? { permissions } : {}),
    extensions: [createMcpExtension({ projectSha256, ...options })] });
  t.after(() => app.close());
  let id = 0;
  return async (method: string, params: unknown) => {
    const response = await fetch(`http://127.0.0.1:${app.address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return { requestId: response.headers.get('x-request-id')!, json: await response.json() as { result?: Record<string, unknown>; error?: { code: number } } };
  };
}

test('a tool handler receives the granted route env, the response request id and its names as a frozen context', async t => {
  const call = await boot(t);
  const { requestId, json } = await call('tools/call', { name: 'record', arguments: { message: 'hi' } });
  const payload = JSON.parse((json.result!.content as { text: string }[])[0]!.text) as { input: unknown; context: Record<string, unknown>; frozen: boolean };
  assert.deepEqual(payload.input, { message: 'hi' }, 'the first argument is unchanged: the validated arguments');
  assert.deepEqual(payload.context, { requestId, env: { SKILLS: 'alpha,beta', REGION: 'eu-west-1' }, server: 'main', tool: 'record', kind: 'tool' });
  assert.equal(payload.frozen, true);
});

test('resource and prompt handlers receive the same context with their own kind and name', async t => {
  const call = await boot(t);
  const resource = await call('resources/read', { uri: 'test://readme' });
  assert.equal((resource.json.result!.contents as { text: string }[])[0]!.text, `resource for ${resource.requestId}`);
  const prompt = await call('prompts/get', { name: 'hello' });
  assert.equal((prompt.json.result!.messages as { content: { text: string } }[])[0]!.content.text, 'prompt:hello:alpha,beta');
});

test('an ungranted env binding on the mcp route refuses activation like a function route', async t => {
  await assert.rejects(boot(t, {}, false), /Environment binding denied by operator policy: SKILLS reads MCP_ENABLED_SKILLS/);
});

test('onToolCall fires once per handler invocation with outcome, duration and the response request id', async t => {
  const calls: McpToolCallInfo[] = [];
  const errors: string[] = [];
  const call = await boot(t, { onToolCall: info => calls.push(info), onToolError: (_error, info) => errors.push(info.tool) });
  const ok = await call('tools/call', { name: 'record', arguments: {} });
  const failed = await call('tools/call', { name: 'boom', arguments: {} });
  const resource = await call('resources/read', { uri: 'test://readme' });
  const prompt = await call('prompts/get', { name: 'hello' });
  await call('tools/call', { name: 'record', arguments: { unknown: 1 } });
  await call('tools/call', { name: 'missing', arguments: {} });
  assert.equal(calls.length, 4, 'refusals before a handler runs are not reported');
  assert.deepEqual(calls.map(({ durationMs: _d, ...rest }) => rest), [
    { server: 'main', tool: 'record', kind: 'tool', outcome: 'success', requestId: ok.requestId },
    { server: 'main', tool: 'boom', kind: 'tool', outcome: 'error', requestId: failed.requestId },
    { server: 'main', tool: 'readme', kind: 'resource', outcome: 'success', requestId: resource.requestId },
    { server: 'main', tool: 'hello', kind: 'prompt', outcome: 'success', requestId: prompt.requestId },
  ]);
  assert.ok(calls.every(info => typeof info.durationMs === 'number' && info.durationMs >= 0));
  assert.deepEqual(errors, ['boom']);
  assert.equal((failed.json.result as { isError: boolean }).isError, true);
});

test('a throwing onToolCall never changes the response', async t => {
  const call = await boot(t, { onToolCall: () => { throw new Error('observer failure'); } });
  const ok = await call('tools/call', { name: 'record', arguments: { message: 'x' } });
  assert.equal((ok.json.result as { isError: boolean }).isError, false);
  const failed = await call('tools/call', { name: 'boom', arguments: {} });
  assert.deepEqual(failed.json.result, { content: [{ type: 'text', text: 'The tool could not complete the request.' }], isError: true });
  const resource = await call('resources/read', { uri: 'test://readme' });
  assert.ok(resource.json.result);
  const prompt = await call('prompts/get', { name: 'hello' });
  assert.ok(prompt.json.result);
});
