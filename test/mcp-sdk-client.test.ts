// #846: the authoring server speaks the protocol through the official SDK, so the official SDK client is the test
// client. It spawns `urlcode mcp` over stdio exactly as an agent host does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { project, redirect } from './helpers.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));

async function connect(root: string, authoring = false): Promise<Client> {
  const client = new Client({ name: 'urlcode-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--conditions=development', cli, 'mcp', '--project', root, ...(authoring ? ['--allow-authoring'] : [])], stderr: 'ignore' }));
  return client;
}
const json = (result: { content: unknown }): Record<string, unknown> => JSON.parse(((result.content as { text: string }[])[0]!).text) as Record<string, unknown>;

test('the official SDK client lists and calls the read tools', async t => {
  const root = await project(t, { '/a': redirect() });
  const client = await connect(root);
  t.after(() => client.close());
  assert.equal(client.getServerVersion()?.name, 'urlcode');
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'validate'));
  assert.ok(!tools.some(tool => tool.name === 'run_validate'), 'authoring tools need --allow-authoring');
  const valid = await client.callTool({ name: 'validate', arguments: {} });
  assert.equal(valid.isError, undefined);
  assert.equal(json(valid).valid, true);
  assert.equal((valid.structuredContent as { valid?: boolean }).valid, true);
});

test('bad arguments and unknown tools are protocol errors that name the problem; a tool failure is a result', async t => {
  const root = await project(t, { '/a': redirect() });
  const client = await connect(root);
  t.after(() => client.close());
  await assert.rejects(client.callTool({ name: 'inspect', arguments: { limit: 1001 } }), /Invalid arguments for inspect: argument "limit" must be <= 1000/);
  await assert.rejects(client.callTool({ name: 'shell', arguments: {} }), /Unknown tool "shell"/);
  await assert.rejects(client.callTool({ name: 'run_validate', arguments: {} }), /needs the --allow-authoring option/);
  const missing = await client.callTool({ name: 'get_recipe', arguments: { name: 'no-such-recipe' } });
  assert.equal(missing.isError, true);
});

test('a cancelled call rejects at the client and the session keeps working', async t => {
  const root = await project(t, { '/a': redirect() });
  const client = await connect(root, true);
  t.after(() => client.close());
  const controller = new AbortController();
  const pending = client.callTool({ name: 'run_validate', arguments: {} }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  // Calls run in order, so the next one answers after the cancelled one has finished on the server.
  const after = await client.callTool({ name: 'validate', arguments: {} });
  assert.equal(json(after).valid, true);
});
