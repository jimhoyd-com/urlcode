// #834: the operator's reviewed policy reaches the inspection commands and the authoring MCP server, so a site whose
// routes need operator-granted bindings validates and tests without PROJECT_SHA256 exports or source searching.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildBootstrap } from '../packages/core/src/bootstrap.ts';
import { buildContext } from '../packages/core/src/context.ts';
import { serveMcp } from '../packages/core/src/mcp.ts';
import { loadOperatorPolicy } from '../packages/core/src/policy.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
// A host that refuses to load unless the CLI or server handed it a verified policy revision, as composeHost does.
const pinnedHost = "const pin = globalThis[Symbol.for('urlcode.host.operatorRevision')];\nif (!/^[a-f0-9]{64}$/.test(pin ?? '')) throw new Error('host loaded without a reviewed revision');\nexport default { extensions: [] };\n";

/** A site whose one route reads an operator-granted binding, with host.mjs, data/ and operator/policy.json. */
async function site(t: TestContext): Promise<{ root: string; app: string; policy: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'urlcode-context-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  await mkdir(join(app, 'functions'), { recursive: true });
  await mkdir(join(root, 'data'));
  await mkdir(join(root, 'operator'));
  await writeFile(join(app, 'urlcode.yaml'), 'version: "1"\nroutes:\n  /greet:\n    env: {GREETING: {env: GREETING}}\n    function: {source: functions/greet.mjs}\n');
  await writeFile(join(app, 'functions', 'greet.mjs'), 'export default (_request, context) => new Response(context.env.GREETING);\n');
  await mkdir(join(app, 'tests'), { recursive: true });
  await writeFile(join(app, 'tests', 'requests.json'), JSON.stringify([{ path: '/greet', status: 200, expectBody: 'hello' }]));
  // Two copies: an import that failed is cached by URL, so each refusal case loads its own copy.
  await writeFile(join(root, 'host.mjs'), pinnedHost);
  await writeFile(join(root, 'unpinned-host.mjs'), pinnedHost);
  const proposal = spawnSync(process.execPath, [cli, 'permissions', '--project', app], { encoding: 'utf8' });
  assert.equal(proposal.status, 0, proposal.stderr);
  const policy = join(root, 'operator', 'policy.json');
  await writeFile(policy, proposal.stdout);
  return { root, app, policy };
}

test('bootstrap repeats the reviewed policy in its commands and keeps operator directories out of the serving advice', async t => {
  const { root, policy } = await site(t);
  const without = await buildBootstrap(root);
  assert.deepEqual(without.prerequisites?.map(item => item.flag), ['--policy']);
  const withPolicy = await buildBootstrap(root, { policy });
  assert.equal(withPolicy.prerequisites, undefined);
  for (const name of ['start', 'dev', 'validate', 'test', 'context']) assert.match(withPolicy.commands![name]!, / --policy operator\/policy\.json$/, name);
  // data/ is operator state and is never offered for serving; other directories never invite copying operator code.
  assert.deepEqual(withPolicy.paths!.outsideProject.map(item => item.path), ['operator']);
  assert.match(withPolicy.paths!.outsideProject[0]!.note, /operator code, credentials and data stay outside the project/);
  // The emitted command runs as printed from the site root.
  const validate = spawnSync(process.execPath, [cli, 'validate', '--local', '--project', 'app', '--host-file', 'host.mjs', '--policy', 'operator/policy.json'], { cwd: root, encoding: 'utf8', env: { ...process.env, GREETING: 'hello' } });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});

test('context and explain load a pinned host from the policy instead of a PROJECT_SHA256 export', async t => {
  const { root, app, policy } = await site(t);
  const hostFile = join(root, 'host.mjs');
  const previous = process.env.PROJECT_SHA256;
  delete process.env.PROJECT_SHA256;
  t.after(() => { if (previous !== undefined) process.env.PROJECT_SHA256 = previous; });
  await assert.rejects(buildContext(app, { hostFile: join(root, 'unpinned-host.mjs') }), /without a reviewed revision/);
  const context = await buildContext(app, { hostFile, policy });
  assert.equal(context.prerequisites, undefined);
  assert.ok(context.commands!.validate!.endsWith(` --host-file ${hostFile} --policy ${policy}`));
  const explained = spawnSync(process.execPath, [cli, 'explain', '/greet', '--project', app, '--host-file', hostFile, '--policy', policy], { encoding: 'utf8', env: { ...process.env, PROJECT_SHA256: '' } });
  assert.equal(explained.status, 0, explained.stderr);
});

test('the authoring MCP server verifies the operator policy once and its runners use it', async t => {
  const { root, app, policy } = await site(t);
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
  const call = (id: number, name: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
  const session = async (options: { policy?: string; hostFile?: string }): Promise<Record<number, Record<string, unknown>>> => {
    let text = '';
    const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
    const messages = [initialize, { jsonrpc: '2.0', method: 'notifications/initialized' }, call(2, 'run_validate'), call(3, 'run_tests'), call(4, 'get_context')];
    await serveMcp({ project: app, hostFile: join(root, 'host.mjs'), allowAuthoring: true, ...options, input: Readable.from([messages.map(value => JSON.stringify(value) + '\n').join('')]), output });
    const replies = text.trim().split('\n').map(line => JSON.parse(line) as { id: number; result: { content: { text: string }[] } });
    return Object.fromEntries(replies.filter(reply => reply.id > 1).map(reply => [reply.id, JSON.parse(reply.result.content[0]!.text) as Record<string, unknown>]));
  };
  const previous = { PROJECT_SHA256: process.env.PROJECT_SHA256, GREETING: process.env.GREETING };
  delete process.env.PROJECT_SHA256;
  process.env.GREETING = 'hello';
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  // Without a policy the host cannot even load: nothing pins it.
  await assert.rejects(session({ hostFile: join(root, 'unpinned-host.mjs') }), /without a reviewed revision/);
  const replies = await session({ policy });
  // The child runner gets only PATH, so the binding value is absent there; the refusal is the value, not the grant.
  assert.doesNotMatch(String(replies[2]!.stderr), /binding-denied|denied by operator policy/);
  assert.deepEqual([replies[3]!.total, replies[3]!.failed], [1, 0]);
  assert.match(String((replies[4]!.commands as Record<string, string>).validate), /--policy /);
});

test('an empty, unparseable or missing policy file is named', async t => {
  const { app, root } = await site(t);
  const file = join(root, 'operator', 'broken.json');
  await writeFile(file, '');
  await assert.rejects(loadOperatorPolicy(file, app), /Operator policy file .*broken\.json is empty/);
  await writeFile(file, '{"version":1,');
  await assert.rejects(loadOperatorPolicy(file, app), /Operator policy file .*broken\.json is not valid JSON/);
  await assert.rejects(loadOperatorPolicy(join(root, 'operator', 'missing.json'), app), /Operator policy file .*missing\.json does not exist/);
});
