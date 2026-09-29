import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createMcpExtension } from '../src/index.ts';

// One project schema (core's top-level `schemas:`, RIM-SCHEMA-001) validates a POST route's body and an MCP tool's
// arguments: both refuse the same invalid input at the same pointer, with the same wording, and tools/list
// advertises the schema itself, resolved.

const origin = 'https://mcp.example.test';
const contact = {
  type: 'object', required: ['name', 'email'], additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, email: { type: 'string', format: 'email' }, address: { $ref: '#/$defs/address' } },
  $defs: { address: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', pattern: '^[0-9]{5}$', maxLength: 5 } } } },
};

async function boot(t: test.TestContext, tool: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-named-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'app'); await mkdir(dir);
  await writeFile(join(dir, 'save.mjs'), 'export default function save(input) { return { saved: input.name }; }\n');
  await writeFile(join(dir, 'urlcode.yaml'), JSON.stringify({
    version: '1', schemas: { contact },
    extensions: { mcp: { version: '1', config: { servers: { default: { mount: '/mcp', serverName: 'contacts', serverVersion: '1.0.0', tools: { save_contact: { description: 'Saves a contact', handler: './save.mjs', ...tool } } } } } } },
    routes: {
      '/mcp/*': { extension: 'mcp', methods: ['POST', 'HEAD'] },
      '/contacts': { methods: ['POST'], request: { body: { POST: { format: 'json', required: true, schema: 'contact' } } }, respond: { status: 201, json: { ok: true } } },
    },
  }));
  const projectSha256 = await inspectExtensionRevision(dir);
  const app = await startServer({ project: dir, origin, port: 0, log: () => {}, extensions: [createMcpExtension({ projectSha256 })] });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address.port}`;
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const text = await response.text();
    const data = response.headers.get('content-type')?.startsWith('text/event-stream') ? text.split('\n').filter(line => line.startsWith('data: ')).at(-1)!.slice(6) : text;
    return JSON.parse(data) as { result: Record<string, unknown> };
  };
  const post = (body: unknown) => fetch(`${base}/contacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { rpc, post };
}

test('a named schema is shared by a POST route and an MCP tool: the same invalid input fails at the same pointer', async t => {
  const { rpc, post } = await boot(t, { inputSchema: 'contact', outputSchema: 'contact' });
  const listed = await rpc('tools/list', {});
  const [tool] = listed.result.tools as { inputSchema: unknown; outputSchema: unknown }[];
  assert.deepEqual(tool!.inputSchema, contact, 'tools/list advertises the resolved schema, never the name');
  for (const [input, pointer] of [[{ name: 'Ann', email: 'nope' }, '/email'], [{ name: 'Ann', email: 'a@b.co', address: { zip: '12x' } }, '/address/zip'], [{ email: 'a@b.co' }, '']] as const) {
    const http = await post(input);
    assert.equal(http.status, 422);
    const issues = (await http.json() as { issues: { pointer: string; message: string }[] }).issues;
    assert.equal(issues[0]!.pointer, pointer);
    const called = await rpc('tools/call', { name: 'save_contact', arguments: input });
    assert.equal(called.result.isError, true);
    const line = `${pointer || '/'} ${issues[0]!.message}`;
    assert.equal((called.result.content as { text: string }[])[0]!.text, `Invalid arguments for tool save_contact: ${line}`);
  }
  // A handler result is checked against the named output schema too.
  const ok = await rpc('tools/call', { name: 'save_contact', arguments: { name: 'Ann', email: 'a@b.co' } });
  assert.equal(ok.result.isError, true, 'the handler returns {saved}, which the contact output schema refuses');
  assert.equal((await post({ name: 'Ann', email: 'a@b.co' })).status, 201);
});

test('an MCP tool naming a schema the project does not declare is refused at activation', async t => {
  await assert.rejects(boot(t, { inputSchema: 'contcat' }), /MCP server default: tool save_contact inputSchema names schema contcat, which the project does not declare under schemas/);
});
