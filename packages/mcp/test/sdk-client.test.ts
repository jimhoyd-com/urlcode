import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createMcpExtension } from '../src/index.ts';
import type { McpServerSpec } from '../src/index.ts';

// #846: the application server speaks the protocol through the official SDK, so the official SDK client is the
// test client. It connects over Streamable HTTP to a real served site, as a deployed agent would.
const origin = 'https://mcp-client.example.test';

async function serve(t: test.TestContext, streaming: boolean): Promise<URL> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-client-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'app'); await mkdir(dir);
  await writeFile(join(dir, 'echo.mjs'), 'export default function echo(input) { return { echoed: input.message }; }\n');
  await writeFile(join(dir, 'count.mjs'), 'export default async function count(input, context) { for (let i = 1; i <= 3; i++) context.progress(i, 3); return `counted ${input.to}`; }\n');
  await writeFile(join(dir, 'readme.mjs'), 'export default function readme() { return "# Readme"; }\n');
  await writeFile(join(dir, 'greet.mjs'), 'export default function greet(input) { return `Say hello to ${input.name}`; }\n');
  const spec: McpServerSpec = {
    mount: '/mcp', serverName: 'client-test', serverVersion: '2.0.0', instructions: 'Declared tools only.',
    tools: {
      echo: { description: 'Echoes', inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1 } }, required: ['message'], additionalProperties: false }, outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false }, handler: './echo.mjs' },
      count: { description: 'Counts with progress', inputSchema: { type: 'object', properties: { to: { type: 'integer' } }, additionalProperties: false }, handler: './count.mjs' },
    },
    resources: { readme: { uri: 'app:///readme', name: 'readme', mimeType: 'text/markdown', handler: './readme.mjs' } },
    prompts: { greet: { arguments: [{ name: 'name', required: true }], handler: './greet.mjs' } },
  };
  await writeFile(join(dir, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { mcp: { version: '1', config: { servers: { main: spec } } } }, routes: { '/mcp/*': { extension: 'mcp', methods: ['GET', 'POST', 'DELETE', 'HEAD'] } } }));
  const app = await startServer({ project: dir, origin, port: 0, log: () => {}, extensions: [createMcpExtension({ projectSha256: await inspectExtensionRevision(dir), streaming })] });
  t.after(() => app.close());
  return new URL(`http://127.0.0.1:${app.address.port}/mcp`);
}
async function connect(t: test.TestContext, url: URL): Promise<Client> {
  const client = new Client({ name: 'urlcode-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url));
  t.after(() => client.close());
  return client;
}

for (const streaming of [false, true]) {
  test(`the official SDK client uses the declared tools, resources and prompts (streaming ${streaming})`, async t => {
    const client = await connect(t, await serve(t, streaming));
    assert.deepEqual(client.getServerVersion(), { name: 'client-test', version: '2.0.0' });
    assert.equal(client.getInstructions(), 'Declared tools only.');
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['count', 'echo']);
    const echoed = await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    assert.deepEqual(echoed.structuredContent, { echoed: 'hi' });
    // A bad argument is a tool execution error the model can read; an unknown tool is a protocol error.
    const invalid = await client.callTool({ name: 'echo', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.match((invalid.content as { text: string }[])[0]!.text, /missing required property message/);
    await assert.rejects(client.callTool({ name: 'nope', arguments: {} }), /Unknown tool: nope/);
    assert.deepEqual((await client.readResource({ uri: 'app:///readme' })).contents, [{ uri: 'app:///readme', mimeType: 'text/markdown', text: '# Readme' }]);
    const prompt = await client.getPrompt({ name: 'greet', arguments: { name: 'Ann' } });
    assert.deepEqual(prompt.messages, [{ role: 'user', content: { type: 'text', text: 'Say hello to Ann' } }]);
    await assert.rejects(client.getPrompt({ name: 'greet', arguments: {} }), /prompt arguments/);
  });
}

test('with streaming on, progress reaches the SDK client before the result', async t => {
  const client = await connect(t, await serve(t, true));
  const progress: number[] = [];
  const counted = await client.callTool({ name: 'count', arguments: { to: 3 } }, { onprogress: update => progress.push(update.progress) });
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(counted.content, [{ type: 'text', text: 'counted 3' }]);
});
