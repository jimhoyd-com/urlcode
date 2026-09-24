import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createMcpExtension } from '../src/index.ts';

const origin = 'https://mcp.example.test';

async function boot(t: test.TestContext, onToolError?: (error: unknown, info: { server: string; tool: string }) => void) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  await writeFile(join(project, 'echo.mjs'), 'export default function echo(input) { return { echoed: input.message }; }\n');
  await writeFile(join(project, 'boom.mjs'), 'export default function boom() { throw new Error("internal detail that must never leak"); }\n');
  const mcp = { version: '1' as const, config: { servers: { default: {
    mount: '/mcp', serverName: 'test-server', serverVersion: '1.2.3', instructions: 'A test MCP server.',
    tools: {
      echo: { description: 'Echoes the message back', inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['message'], additionalProperties: false }, handler: './echo.mjs' },
      boom: { description: 'Always throws', inputSchema: { type: 'object', additionalProperties: false }, handler: './boom.mjs' },
    },
  } } } };
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { mcp }, routes: { '/mcp/*': { extension: 'mcp', methods: ['POST', 'HEAD'] } } }));
  const projectSha256 = await inspectExtensionRevision(project);
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [createMcpExtension({ projectSha256, ...(onToolError ? { onToolError } : {}) })] });
  t.after(() => app.close());
  const call = (body: unknown, init: RequestInit = {}) => fetch(`http://127.0.0.1:${app.address.port}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...init.headers }, body: JSON.stringify(body), ...init,
  });
  return { call, port: app.address.port };
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
  const seen: { error: unknown; info: { server: string; tool: string } }[] = [];
  const { call } = await boot(t, (error, info) => seen.push({ error, info }));
  const response = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(response.status, 200);
  const json = await response.json() as { result: { content: { text: string }[]; isError: boolean } };
  assert.equal(json.result.isError, true);
  assert.ok(!json.result.content[0]!.text.includes('internal detail'), 'the real error text must never reach the caller');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.info.server, 'default');
  assert.equal(seen[0]!.info.tool, 'boom');
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

  const ok = await call({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(ok.status, 200);
});
