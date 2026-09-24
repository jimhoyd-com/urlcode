import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createMcpExtension } from '../src/index.ts';
import type { McpServerSpec } from '../src/index.ts';

const origin = 'https://mcp.example.test';
type OnToolError = (error: unknown, info: { server: string; tool: string; kind: 'tool' | 'resource' | 'prompt' }) => void;

/** Boots a server for one project directory, whose files a caller writes before calling `start()`. */
async function project(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'app'); await mkdir(dir);
  const write = (name: string, content: string) => writeFile(join(dir, name), content);
  const start = async (spec: McpServerSpec, onToolError?: OnToolError) => {
    const mcp = { version: '1' as const, config: { servers: { default: spec } } };
    await write('urlcode.yaml', JSON.stringify({ version: '1', extensions: { mcp }, routes: { [`${spec.mount}/*`]: { extension: 'mcp', methods: ['POST', 'HEAD'] } } }));
    const projectSha256 = await inspectExtensionRevision(dir);
    const app = await startServer({ project: dir, origin, port: 0, log: () => {}, extensions: [createMcpExtension({ projectSha256, ...(onToolError ? { onToolError } : {}) })] });
    t.after(() => app.close());
    const call = (body: unknown, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.address.port}${spec.mount}`, {
      method: 'POST', body: JSON.stringify(body), ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
    return { call, port: app.address.port };
  };
  return { dir, write, start };
}

async function boot(t: test.TestContext, onToolError?: OnToolError) {
  const p = await project(t);
  await p.write('echo.mjs', 'export default function echo(input) { return { echoed: input.message }; }\n');
  await p.write('boom.mjs', 'export default function boom() { throw new Error("internal detail that must never leak"); }\n');
  return p.start({
    mount: '/mcp', serverName: 'test-server', serverVersion: '1.2.3', instructions: 'A test MCP server.',
    tools: {
      echo: { description: 'Echoes the message back', inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['message'], additionalProperties: false }, handler: './echo.mjs' },
      boom: { description: 'Always throws', inputSchema: { type: 'object', additionalProperties: false }, handler: './boom.mjs' },
    },
  }, onToolError);
}

test('initialize round-trips the requested protocol version and the exact client request id (not a generated one)', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', id: 'client-picks-this-id', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' } } });
  assert.equal(response.status, 200);
  const json = await response.json() as { jsonrpc: string; id: unknown; result: { protocolVersion: string; serverInfo: { name: string; version: string }; instructions: string; capabilities: { tools: { listChanged: boolean } } } };
  assert.equal(json.jsonrpc, '2.0');
  assert.equal(json.id, 'client-picks-this-id', 'the response id must be exactly the id the client sent, never a substitute');
  assert.equal(json.result.protocolVersion, '2025-03-26');
  assert.deepEqual(json.result.serverInfo, { name: 'test-server', version: '1.2.3' });
  assert.equal(json.result.instructions, 'A test MCP server.');
  assert.equal(json.result.capabilities.tools.listChanged, false);
});

test('initialize falls back to the default supported protocol version for an unrecognized request', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  const json = await response.json() as { result: { protocolVersion: string } };
  assert.equal(json.result.protocolVersion, '2025-06-18');
});

test('request ids of every JSON-RPC-legal shape (integer, zero, negative, string) round-trip exactly, never coerced', async t => {
  const { call } = await boot(t);
  for (const id of [0, -7, 424242, 'abc-123', '']) {
    const response = await call({ jsonrpc: '2.0', id, method: 'ping' });
    const json = await response.json() as { id: unknown };
    assert.equal(json.id, id, `id ${JSON.stringify(id)} should round-trip unchanged`);
  }
});

test('notifications/initialized (no id) gets 202 and no JSON-RPC body: the server never answers a notification', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
});

test('tools/list reports the declared bounded tool set with its input schema', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const json = await response.json() as { result: { tools: { name: string; description: string; inputSchema: unknown }[] } };
  const names = json.result.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['boom', 'echo']);
  const echo = json.result.tools.find(tool => tool.name === 'echo')!;
  assert.equal(echo.description, 'Echoes the message back');
  assert.deepEqual(echo.inputSchema, { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['message'], additionalProperties: false });
});

test('tools/call runs the declared trusted handler and wraps its return value as MCP tool content', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo', arguments: { message: 'hello there' } } });
  const json = await response.json() as { id: unknown; result: { content: { type: string; text: string }[]; isError: boolean } };
  assert.equal(json.id, 9);
  assert.equal(json.result.isError, false);
  assert.deepEqual(JSON.parse(json.result.content[0]!.text), { echoed: 'hello there' });
});

test('tools/call answers -32602 with structured issues for arguments that fail the declared input schema, reusing request.body.schema wording', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } });
  const json = await response.json() as { error: { code: number; message: string; data: { issues: string[] } } };
  assert.equal(json.error.code, -32602);
  assert.ok(json.error.data.issues.some(issue => issue.includes('missing required property message')), JSON.stringify(json.error.data.issues));
});

test('tools/call answers -32602 for an unknown tool name', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'does-not-exist', arguments: {} } });
  const json = await response.json() as { error: { code: number; message: string } };
  assert.equal(json.error.code, -32602);
  assert.match(json.error.message, /does-not-exist/);
});

test('a thrown handler error becomes a tool result with isError true and a fixed generic message, never the real error text, and the host callback observes it', async t => {
  const seen: { error: unknown; info: { server: string; tool: string; kind: string } }[] = [];
  const { call } = await boot(t, (error, info) => seen.push({ error, info }));
  const response = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(response.status, 200);
  const json = await response.json() as { result: { content: { text: string }[]; isError: boolean } };
  assert.equal(json.result.isError, true);
  assert.ok(!json.result.content[0]!.text.includes('internal detail'), 'the real error text must never reach the caller');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.info.server, 'default');
  assert.equal(seen[0]!.info.tool, 'boom');
  assert.equal(seen[0]!.info.kind, 'tool');
  assert.match((seen[0]!.error as Error).message, /internal detail/);
});

test('protocol-level failures: parse error, invalid envelope, batching and unknown method', async t => {
  const { port } = await boot(t);
  const raw = (body: string) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const parseError = await raw('{not json');
  assert.equal(parseError.status, 200);
  assert.deepEqual(await parseError.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

  const notAnEnvelope = await raw(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }));
  assert.deepEqual(await notAnEnvelope.json(), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });

  const batch = await raw(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
  const batchJson = await batch.json() as { error: { code: number } };
  assert.equal(batchJson.error.code, -32600);

  const unknownMethod = await raw(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'not/a/real/method' }));
  const unknownJson = await unknownMethod.json() as { error: { code: number } };
  assert.equal(unknownJson.error.code, -32601);
});

test('transport-level rules: JSON content type required, GET refused, oversized body refused, unknown sub-path 404s', async t => {
  const { call, port } = await boot(t);
  const wrongType = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);

  // The route itself only declares POST and HEAD (see boot()); core's own router refuses GET
  // before the extension is ever invoked, which is a valid way to reach the same 405.
  const get = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, HEAD');

  const tooBig = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { padding: 'x'.repeat(300 * 1024) } }) });
  assert.equal(tooBig.status, 413);

  const subPath = await fetch(`http://127.0.0.1:${port}/mcp/unexpected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(subPath.status, 404);

  // The endpoint is the declared mount exactly; `/mcp/*` is only the route syntax core requires.
  const trailingSlash = await fetch(`http://127.0.0.1:${port}/mcp/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal(trailingSlash.status, 404);

  const ok = await call({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(ok.status, 200);
});

test('initialize only advertises resources/prompts capabilities when the server declares at least one of them', async t => {
  const { call } = await boot(t);
  const response = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const json = await response.json() as { result: { capabilities: Record<string, unknown> } };
  assert.deepEqual(Object.keys(json.result.capabilities).sort(), ['tools']);
});

test('tools/list paginates a bounded tool set with an opaque cursor, sorted by name, and covers every tool exactly once', async t => {
  const p = await project(t);
  await p.write('echo.mjs', 'export default function echo() { return "ok"; }\n');
  const names = Array.from({ length: 25 }, (_, index) => `tool-${String(index).padStart(2, '0')}`);
  const tools = Object.fromEntries(names.map(name => [name, { description: `Tool ${name}`, inputSchema: { type: 'object' as const, additionalProperties: false }, handler: './echo.mjs' }]));
  const { call } = await p.start({ mount: '/mcp', serverName: 'paged', serverVersion: '1.0.0', tools });

  const first = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const firstJson = await first.json() as { result: { tools: { name: string }[]; nextCursor?: string } };
  assert.equal(firstJson.result.tools.length, 20);
  assert.ok(firstJson.result.nextCursor, 'a 25-tool list must not fit on one 20-entry page');
  assert.deepEqual(firstJson.result.tools.map(tool => tool.name), [...names].sort().slice(0, 20));

  const second = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: firstJson.result.nextCursor } });
  const secondJson = await second.json() as { result: { tools: { name: string }[]; nextCursor?: string } };
  assert.equal(secondJson.result.tools.length, 5);
  assert.equal(secondJson.result.nextCursor, undefined, 'the last page carries no nextCursor');
  assert.deepEqual([...firstJson.result.tools, ...secondJson.result.tools].map(tool => tool.name).sort(), [...names].sort());

  const badCursor = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'not-a-real-cursor' } });
  const badCursorJson = await badCursor.json() as { error: { code: number } };
  assert.equal(badCursorJson.error.code, -32602);
});

test('a tool with a declared outputSchema returns structuredContent, validated against that schema', async t => {
  const p = await project(t);
  await p.write('weather.mjs', 'export default function weather() { return { temperature: 22.5, conditions: "Partly cloudy" }; }\n');
  await p.write('bad-weather.mjs', 'export default function badWeather() { return { temperature: "not a number" }; }\n');
  const outputSchema = { type: 'object' as const, properties: { temperature: { type: 'number' as const }, conditions: { type: 'string' as const } }, required: ['temperature', 'conditions'], additionalProperties: false };
  const seen: { info: { tool: string; kind: string } }[] = [];
  const { call } = await p.start({
    mount: '/mcp', serverName: 'structured', serverVersion: '1.0.0',
    tools: {
      weather: { description: 'Get the weather', inputSchema: { type: 'object', additionalProperties: false }, outputSchema, handler: './weather.mjs' },
      bad_weather: { description: 'A handler that violates its own outputSchema', inputSchema: { type: 'object', additionalProperties: false }, outputSchema, handler: './bad-weather.mjs' },
    },
  }, (_error, info) => seen.push({ info }));

  const list = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const listJson = await list.json() as { result: { tools: { name: string; outputSchema?: unknown }[] } };
  assert.deepEqual(listJson.result.tools.find(tool => tool.name === 'weather')!.outputSchema, outputSchema);

  const call1 = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'weather', arguments: {} } });
  const call1Json = await call1.json() as { result: { content: { text: string }[]; structuredContent: unknown; isError: boolean } };
  assert.equal(call1Json.result.isError, false);
  assert.deepEqual(call1Json.result.structuredContent, { temperature: 22.5, conditions: 'Partly cloudy' });
  assert.deepEqual(JSON.parse(call1Json.result.content[0]!.text), { temperature: 22.5, conditions: 'Partly cloudy' });

  const call2 = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bad_weather', arguments: {} } });
  const call2Json = await call2.json() as { result: { isError: boolean } };
  assert.equal(call2Json.result.isError, true, 'a handler result that fails its own declared outputSchema is a server-side contract violation');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.info.kind, 'tool');
});

test('resources/list and resources/read serve declared bounded resources, including a not-found error and a handler failure', async t => {
  const p = await project(t);
  await p.write('readme.mjs', 'export default function readme() { return "# Hello\\n"; }\n');
  await p.write('data.mjs', 'export default function data() { return { text: "{}", mimeType: "application/json" }; }\n');
  await p.write('resource-boom.mjs', 'export default function boom() { throw new Error("internal resource detail"); }\n');
  const seen: { info: { tool: string; kind: string } }[] = [];
  const { call } = await p.start({
    mount: '/mcp', serverName: 'resourced', serverVersion: '1.0.0',
    tools: { noop: { description: 'no-op', inputSchema: { type: 'object', additionalProperties: false }, handler: './readme.mjs' } },
    resources: {
      readme: { uri: 'file:///project/README.md', name: 'README', description: 'The README', mimeType: 'text/markdown', handler: './readme.mjs' },
      config: { uri: 'app:///config.json', name: 'config', handler: './data.mjs' },
      broken: { uri: 'app:///broken', name: 'broken', handler: './resource-boom.mjs' },
    },
  }, (_error, info) => seen.push({ info }));

  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const initJson = await init.json() as { result: { capabilities: Record<string, unknown> } };
  assert.ok('resources' in initJson.result.capabilities);
  assert.equal('prompts' in initJson.result.capabilities, false);

  const list = await call({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  const listJson = await list.json() as { result: { resources: { uri: string; name: string; mimeType?: string }[] } };
  assert.deepEqual(listJson.result.resources.map(r => r.uri).sort(), ['app:///broken', 'app:///config.json', 'file:///project/README.md']);
  assert.equal(listJson.result.resources.find(r => r.uri === 'file:///project/README.md')!.mimeType, 'text/markdown');

  const read = await call({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'file:///project/README.md' } });
  const readJson = await read.json() as { result: { contents: { uri: string; mimeType?: string; text?: string }[] } };
  assert.deepEqual(readJson.result.contents, [{ uri: 'file:///project/README.md', mimeType: 'text/markdown', text: '# Hello\n' }]);

  const readData = await call({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'app:///config.json' } });
  const readDataJson = await readData.json() as { result: { contents: { text?: string; mimeType?: string }[] } };
  assert.deepEqual(readDataJson.result.contents[0], { uri: 'app:///config.json', mimeType: 'application/json', text: '{}' });

  const notFound = await call({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'app:///nope' } });
  const notFoundJson = await notFound.json() as { error: { code: number; data: { uri: string } } };
  assert.equal(notFoundJson.error.code, -32002);
  assert.equal(notFoundJson.error.data.uri, 'app:///nope');

  const broken = await call({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'app:///broken' } });
  const brokenJson = await broken.json() as { error: { code: number; message: string } };
  assert.equal(brokenJson.error.code, -32603);
  assert.ok(!brokenJson.error.message.includes('internal resource detail'), 'the real error text must never reach the caller');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.info.kind, 'resource');
});

test('prompts/list and prompts/get serve declared bounded prompts, validating arguments and reporting an unknown name or a handler failure', async t => {
  const p = await project(t);
  await p.write('code-review.mjs', 'export default function codeReview(args) { return [{ role: "user", text: `Please review:\\n${args.code}` }]; }\n');
  await p.write('greeting.mjs', 'export default function greeting() { return "Hi there"; }\n');
  await p.write('prompt-boom.mjs', 'export default function boom() { throw new Error("internal prompt detail"); }\n');
  const seen: { info: { tool: string; kind: string } }[] = [];
  const { call } = await p.start({
    mount: '/mcp', serverName: 'prompted', serverVersion: '1.0.0',
    tools: { noop: { description: 'no-op', inputSchema: { type: 'object', additionalProperties: false }, handler: './greeting.mjs' } },
    prompts: {
      code_review: { description: 'Ask for a code review', arguments: [{ name: 'code', description: 'The code to review', required: true }], handler: './code-review.mjs' },
      greeting: { handler: './greeting.mjs' },
      broken: { handler: './prompt-boom.mjs' },
    },
  }, (_error, info) => seen.push({ info }));

  const list = await call({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  const listJson = await list.json() as { result: { prompts: { name: string; description?: string; arguments?: { name: string; required?: boolean }[] }[] } };
  const codeReview = listJson.result.prompts.find(p2 => p2.name === 'code_review')!;
  assert.equal(codeReview.description, 'Ask for a code review');
  assert.deepEqual(codeReview.arguments, [{ name: 'code', description: 'The code to review', required: true }]);
  assert.equal(listJson.result.prompts.find(p2 => p2.name === 'greeting')!.arguments, undefined);

  const get = await call({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'code_review', arguments: { code: 'def f(): pass' } } });
  const getJson = await get.json() as { result: { description?: string; messages: { role: string; content: { type: string; text: string } }[] } };
  assert.equal(getJson.result.description, 'Ask for a code review');
  assert.deepEqual(getJson.result.messages, [{ role: 'user', content: { type: 'text', text: 'Please review:\ndef f(): pass' } }]);

  const getString = await call({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'greeting' } });
  const getStringJson = await getString.json() as { result: { messages: { role: string; content: { type: string; text: string } }[] } };
  assert.deepEqual(getStringJson.result.messages, [{ role: 'user', content: { type: 'text', text: 'Hi there' } }]);

  const missingArg = await call({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'code_review', arguments: {} } });
  const missingArgJson = await missingArg.json() as { error: { code: number; data: { issues: string[] } } };
  assert.equal(missingArgJson.error.code, -32602);
  assert.ok(missingArgJson.error.data.issues.some(issue => issue.includes('missing required property code')), JSON.stringify(missingArgJson.error.data.issues));

  const unknown = await call({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'does-not-exist' } });
  const unknownJson = await unknown.json() as { error: { code: number; message: string } };
  assert.equal(unknownJson.error.code, -32602);
  assert.match(unknownJson.error.message, /does-not-exist/);

  const broken = await call({ jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'broken' } });
  const brokenJson = await broken.json() as { error: { code: number; message: string } };
  assert.equal(brokenJson.error.code, -32603);
  assert.ok(!brokenJson.error.message.includes('internal prompt detail'), 'the real error text must never reach the caller');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.info.kind, 'prompt');
});

test('Origin: a foreign Origin is refused with 403 before parsing; the site origin and an absent Origin are admitted', async t => {
  const { call } = await boot(t);
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  const foreign = await call(ping, { headers: { origin: 'https://attacker.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(await foreign.text(), 'Forbidden');
  // Refused before JSON parsing: a malformed body still gets 403, not a JSON-RPC parse error.
  const foreignMalformed = await call(ping, { headers: { origin: 'https://attacker.example' }, body: '{not json' });
  assert.equal(foreignMalformed.status, 403);
  // Exact match only: a different scheme, port or the literal `null` origin is foreign.
  for (const other of ['http://mcp.example.test', 'https://mcp.example.test:8443', 'null']) {
    assert.equal((await call(ping, { headers: { origin: other } })).status, 403, other);
  }

  const same = await call(ping, { headers: { origin } });
  assert.equal(same.status, 200);
  assert.equal((await same.json() as { id: unknown }).id, 1);

  const absent = await call(ping);
  assert.equal(absent.status, 200);
});

test('MCP-Protocol-Version: an unsupported header on a non-initialize message is refused with 400; a missing or supported one is accepted; initialize ignores it', async t => {
  const { call } = await boot(t);
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  const unsupported = await call(ping, { headers: { 'mcp-protocol-version': '1999-01-01' } });
  assert.equal(unsupported.status, 400);
  const unsupportedNotification = await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'mcp-protocol-version': '1999-01-01' } });
  assert.equal(unsupportedNotification.status, 400);

  const missing = await call(ping);
  assert.equal(missing.status, 200, 'a missing header is treated as 2025-03-26, which is supported');
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    assert.equal((await call(ping, { headers: { 'mcp-protocol-version': version } })).status, 200, version);
  }

  // initialize negotiates from params.protocolVersion, before any revision exists to put in the header.
  const initialize = await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { headers: { 'mcp-protocol-version': '1999-01-01' } });
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json() as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
});

test('tools/list, resources/list and prompts/list echo a declared title and tool annotations, omitting them when absent', async t => {
  const p = await project(t);
  await p.write('noop.mjs', 'export default function noop() { return "ok"; }\n');
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const { call } = await p.start({
    mount: '/mcp', serverName: 'titled', serverVersion: '1.0.0',
    tools: {
      lookup: { title: 'Look up a record', description: 'Read-only lookup', annotations, inputSchema: { type: 'object', additionalProperties: false }, handler: './noop.mjs' },
      submit: { description: 'Submit feedback', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', additionalProperties: false }, handler: './noop.mjs' },
      plain: { description: 'No title or hints', inputSchema: { type: 'object', additionalProperties: false }, handler: './noop.mjs' },
    },
    resources: {
      readme: { uri: 'app:///readme', name: 'readme', title: 'Project README', handler: './noop.mjs' },
      bare: { uri: 'app:///bare', name: 'bare', handler: './noop.mjs' },
    },
    prompts: {
      greet: { title: 'Greeting', handler: './noop.mjs' },
      bare: { handler: './noop.mjs' },
    },
  });

  const tools = (await (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as { result: { tools: Record<string, unknown>[] } }).result.tools;
  const tool = (name: string) => tools.find(entry => entry.name === name)!;
  assert.equal(tool('lookup').title, 'Look up a record');
  assert.deepEqual(tool('lookup').annotations, annotations);
  assert.deepEqual(tool('submit').annotations, { readOnlyHint: false });
  assert.equal('title' in tool('submit'), false);
  assert.equal('title' in tool('plain'), false);
  assert.equal('annotations' in tool('plain'), false);

  const resources = (await (await call({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).json() as { result: { resources: Record<string, unknown>[] } }).result.resources;
  assert.equal(resources.find(entry => entry.name === 'readme')!.title, 'Project README');
  assert.equal('title' in resources.find(entry => entry.name === 'bare')!, false);

  const prompts = (await (await call({ jsonrpc: '2.0', id: 3, method: 'prompts/list' })).json() as { result: { prompts: Record<string, unknown>[] } }).result.prompts;
  assert.equal(prompts.find(entry => entry.name === 'greet')!.title, 'Greeting');
  assert.equal('title' in prompts.find(entry => entry.name === 'bare')!, false);
});

test('an unknown tool annotation hint, a non-boolean hint value or an empty title is refused at validation', async t => {
  const tool = (extra: Record<string, unknown>) => ({ description: 'x', inputSchema: { type: 'object', additionalProperties: false }, handler: './noop.mjs', ...extra });
  const start = async (extra: Record<string, unknown>) => {
    const p = await project(t);
    await p.write('noop.mjs', 'export default function noop() { return "ok"; }\n');
    return p.start({ mount: '/mcp', serverName: 'checked', serverVersion: '1.0.0', tools: { tool: tool(extra) } } as unknown as McpServerSpec);
  };
  // Control: the same tool with every valid hint and a title starts, so each refusal below is caused by the one bad field.
  await start({ title: 'Valid', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  // Each refusal names the failing field and the failed check, never the rejected value.
  const at = '/extensions/mcp/config/servers/default/tools/tool';
  const cases: [string, Record<string, unknown>, string][] = [
    ['unknown hint', { annotations: { readOnlyHint: true, cachedHint: true } }, `${at}/annotations (additionalProperties): unknown key "cachedHint"; allowed keys: readOnlyHint, destructiveHint, idempotentHint, openWorldHint (run urlcode extensions --json for its configuration schema)`],
    ['non-boolean hint', { annotations: { readOnlyHint: 'yes' } }, `${at}/annotations/readOnlyHint (type): must be boolean`],
    ['title inside annotations', { annotations: { title: 'Nope' } }, `${at}/annotations (additionalProperties): unknown key "title"; allowed keys: readOnlyHint, destructiveHint, idempotentHint, openWorldHint (run urlcode extensions --json for its configuration schema)`],
    ['empty title', { title: '' }, `${at}/title (minLength): must NOT have fewer than 1 characters`],
    ['over-long title', { title: 'x'.repeat(257) }, `${at}/title (maxLength): must NOT have more than 256 characters`],
  ];
  for (const [label, extra, message] of cases) {
    await assert.rejects(start(extra), { message: `Invalid extension configuration at ${message}` }, `${label} must be refused before the server starts`);
  }
});
