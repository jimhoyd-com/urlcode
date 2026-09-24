import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { startServer } from '../packages/core/src/server.ts';
import type { Server, ServerOptions } from '../packages/core/src/server.ts';
import { project, request, approveBindings } from './helpers.ts';
import type { TestContext } from 'node:test';

// #580: a failing function answers a generic 502, but `dev` (and
// `serve --debug-errors`) must say which route and file failed, and why.
async function app(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<{ server: Server; lines: Record<string, unknown>[]; events: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [], events: Record<string, unknown>[] = [];
  const server = await startServer({ project: root, port: 0, log: event => { events.push(event as Record<string, unknown>); }, diagnostics: line => { lines.push(JSON.parse(line) as Record<string, unknown>); }, ...options });
  t.after(() => server.close());
  return { server, lines, events };
}

test('debugErrors names the route, source, export and stack of a throwing trusted function; the response stays generic', async t => {
  const root = await project(t, { '/boom': { function: { source: 'lib/f.mjs', export: 'handle' } } }, {
    'lib/f.mjs': 'export function handle() {\n  throw new Error("database password rejected");\n}\n',
  });
  const { server, lines, events } = await app(t, root, { debugErrors: true, requestLog: 'detailed' });
  const response = await request(server, '/boom');
  assert.equal(response.status, 502);
  assert.equal(response.body.includes('database password'), false);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line!.event, 'function_error');
  assert.equal(line!.route, '/boom');
  assert.equal(line!.status, 502);
  assert.equal(line!.source, 'lib/f.mjs');
  assert.equal(line!.export, 'handle');
  assert.equal(line!.message, 'database password rejected');
  assert.match(String(line!.stack), /lib\/f\.mjs.*:2:/);
  // The event log and observers keep their no-exception-text guarantee.
  assert.equal(JSON.stringify(events).includes('database password'), false);
});

test('a handler error keeps naming the handler through middleware, and shape failures say what was wrong', async t => {
  const root = await project(t, {
    '/chain': { middleware: [{ source: 'mw.mjs' }], function: { source: 'f.mjs' } },
    '/shape': { function: { source: 'shape.mjs' } },
  }, {
    'mw.mjs': 'export default async (request, context, next) => next();\n',
    'f.mjs': 'export default () => { throw new TypeError("bad input"); };\n',
    'shape.mjs': 'export default () => "not a response";\n',
  });
  const { server, lines } = await app(t, root, { debugErrors: true });
  assert.equal((await request(server, '/chain')).status, 502);
  assert.equal((await request(server, '/shape')).status, 502);
  assert.deepEqual(lines.map(line => [line.route, line.source, line.message]), [
    ['/chain', 'f.mjs', 'bad input'],
    ['/shape', 'shape.mjs', 'the handler did not return a Response'],
  ]);
});

test('without debugErrors a function failure writes no diagnostics', async t => {
  const root = await project(t, { '/boom': { function: { source: 'f.mjs' } } }, { 'f.mjs': 'export default () => { throw new Error("hidden"); };\n' });
  const { server, lines } = await app(t, root);
  assert.equal((await request(server, '/boom')).status, 502);
  assert.deepEqual(lines, []);
});

test('a rejected reload reports the message validate prints, and keeps serving the last snapshot', async t => {
  const root = await project(t, { '/a': { respond: { text: 'one' } } });
  const { server, lines, events } = await app(t, root, { debugErrors: true });
  await writeFile(join(root, 'urlcode.yaml'), stringify({ version: '1', routes: { a: { respond: { text: 'two' } } } }));
  const validateMessage = await createRuntime(root).then(() => 'valid', (error: Error) => error.message);
  assert.equal(await server.reload(), false);
  assert.equal((await request(server, '/a')).body.trim(), 'one');
  assert.deepEqual(events.filter(event => event.event === 'reload'), [{ event: 'reload', status: 'rejected' }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.event, 'reload_rejected');
  assert.equal(lines[0]!.message, validateMessage);
  assert.notEqual(validateMessage, 'valid');
});

test('a policy pinned to an older revision says so on a rejected reload and names urlcode permissions', async t => {
  const route = { function: { source: 'f.mjs' }, secrets: { KEY: { secret: 'API_KEY' } } };
  const root = await project(t, { '/a': route }, { 'f.mjs': 'export default (request, context) => new Response(String(context.secrets.KEY.length));\n' });
  const permissions = await approveBindings(root);
  const { server, lines } = await app(t, root, { debugErrors: true, permissions, environment: { API_KEY: 'secret-value' } });
  assert.equal((await request(server, '/a')).body, '12');
  // Any edit changes the project revision the policy is pinned to.
  await writeFile(join(root, 'urlcode.yaml'), stringify({ version: '1', routes: { '/a': route, '/b': { respond: { text: 'new' } } } }));
  assert.equal(await server.reload(), false);
  const message = String(lines[0]!.message);
  assert.match(message, /^Route \/a: Secret binding denied by operator policy: the policy is pinned to project revision [a-f0-9]{64}, but the project is now revision [a-f0-9]{64}/);
  assert.match(message, new RegExp(permissions.projectSha256));
  assert.match(message, /urlcode permissions/);
  assert.equal(message.includes('secret-value'), false);
});

test('function initialization failures name the file, line and export', async t => {
  const route = (source: string, name?: string) => ({ '/': { function: { source, ...(name ? { export: name } : {}) } } });
  const syntax = await project(t, route('f.mjs'), { 'f.mjs': 'const a = 1;\nexport default () => {\n  return (;\n};\n' });
  await assert.rejects(createRuntime(syntax), { message: /^Function initialization failed in f\.mjs:3 \(export default\): SyntaxError: / });
  const thrown = await project(t, route('f.mjs'), { 'f.mjs': 'const a = 1;\nthrow new Error("top-level boom");\nexport default () => new Response("x");\n' });
  await assert.rejects(createRuntime(thrown), { message: 'Function initialization failed in f.mjs:2 (export default): top-level boom' });
  const missing = await project(t, route('f.mjs', 'handle'), { 'f.mjs': 'export default () => new Response("x");\n' });
  await assert.rejects(createRuntime(missing), { message: 'Function initialization failed in f.mjs (export handle): the module has no export named "handle"' });
  const nested = await project(t, route('f.mjs'), { 'f.mjs': 'import "./broken.mjs";\nexport default () => new Response("x");\n', 'broken.mjs': 'export default (;\n' });
  await assert.rejects(createRuntime(nested), { message: /^Function initialization failed in f\.mjs \(export default\), in a module it imports: SyntaxError/ });
  const unresolved = await project(t, route('f.mjs'), { 'f.mjs': 'import x from "urlcode-no-such-package";\nexport default x;\n' });
  await assert.rejects(createRuntime(unresolved), { message: /^Function initialization failed in f\.mjs \(export default\): Cannot find package 'urlcode-no-such-package'/ });
});

test('the CLI prints the named init failure and keeps --debug-errors to serve', async t => {
  const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
  const root = await project(t, { '/': { function: { source: 'f.mjs' } } }, { 'f.mjs': 'export default () => {\n  return (;\n};\n' });
  const validate = spawnSync(process.execPath, [cli, 'validate', '--project', root], { encoding: 'utf8', timeout: 20000 });
  assert.equal(validate.status, 1);
  assert.match((JSON.parse(validate.stderr) as { message: string }).message, /^Function initialization failed in f\.mjs:2 \(export default\): SyntaxError/);
  const misplaced = spawnSync(process.execPath, [cli, 'validate', '--debug-errors', '--project', root], { encoding: 'utf8', timeout: 20000 });
  assert.equal(misplaced.status, 1);
  assert.match((JSON.parse(misplaced.stderr) as { message: string }).message, /--debug-errors is only supported by serve/);
});
