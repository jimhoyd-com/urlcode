import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, validateDocument } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import mcp from '../src/extension.ts';
import { mcpConfigSchema } from '../src/mcp.ts';

const PROJECT_SHA256 = 'b'.repeat(64);
const request = { site: '/tmp/site', project: '/tmp/site/app', installed: ['mcp'], acknowledgements: [] } as const;

function pin(t: test.TestContext, value: string): void {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = value;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
}

test('the definition names mcp, requires nothing and shares the runtime schema', () => {
  assert.equal(mcp.definition.name, 'mcp');
  assert.deepEqual(mcp.definition.requires, []);
  assert.equal(mcp.definition.schema, mcpConfigSchema);
});

test('scaffold declares no server or route (a tool needs a handler under app/) and says what to add', async () => {
  const result = await mcp.definition.scaffold!(request);
  assert.deepEqual(result.config, {});
  assert.deepEqual(result.routes, {});
  assert.equal(result.acknowledged, undefined);
  assert.match(result.notes!.join(' '), /app\/mcp-tools\/get-time\.mjs/);
  assert.deepEqual(await mcp.definition.scaffold!({ ...request, installed: ['auth', 'mcp', 'ui'] }), result, 'other installed extensions do not change the result');
  validateDocument({ version: '1', extensions: { mcp: { version: '1', config: result.config } }, routes: result.routes });
});

test('host() registers mcp through composeHost with the reviewed pin', async t => {
  pin(t, PROJECT_SHA256);
  const site = await mkdtemp(join(tmpdir(), 'mcp-host-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const errors: unknown[] = [];
  const host = await composeHost(pathToFileURL(join(site, 'host.mjs')), [mcp({ onToolError: error => { errors.push(error); } })]);
  assert.equal(host.extensions!.length, 1);
  assert.equal(host.extensions![0]!.name, 'mcp');
  assert.equal(host.extensions![0]!.projectSha256, PROJECT_SHA256);
  await host.close?.();
});

test('the scaffolded empty declaration activates and serves, so a fresh add does not break the site', async t => {
  const site = await mkdtemp(join(tmpdir(), 'mcp-empty-'));
  t.after(() => rm(site, { recursive: true, force: true }));
  const project = join(site, 'app');
  await mkdir(project);
  const { config } = await mcp.definition.scaffold!(request);
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { mcp: { version: '1', config } }, routes: { '/': { respond: { text: 'ok' } } } }));
  pin(t, await inspectExtensionRevision(project));
  const host = await composeHost(pathToFileURL(join(site, 'host.mjs')), [mcp()]);
  const app = await startServer({ project, origin: 'https://mcp.example.test', port: 0, log: () => {}, extensions: host.extensions! });
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.address.port}/`);
  assert.equal(response.status, 200);
});
