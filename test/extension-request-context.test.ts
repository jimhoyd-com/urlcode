import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { project, request, approveBindings } from './helpers.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { startServer } from '../packages/core/src/server.ts';
import { extensionHookContext, inspectExtensionRevision, loadExtensionHooks } from '../packages/core/src/extensions.ts';
import type { ExtensionRequest, RuntimeExtension } from '../packages/core/src/extensions.ts';
// RIM-EXT-REQUEST-001 (docs/RUNTIME-IMPLEMENTATION.md, urlcode#678): an `extension:` route may declare
// `env` under the same revision-pinned operator grant a function route uses, and the compiled values
// reach `ExtensionRequest.env`; every request carries one request id that reaches the extension
// request, the hook context and both function executors, and equals the response's X-Request-Id.
const origin = 'https://ext-request.example.test';
async function recorder(root: string, seen: ExtensionRequest[]): Promise<RuntimeExtension> {
  return {
    name: 'rec', version: '1', projectSha256: await inspectExtensionRevision(root), targets: ['node', 'aws', 'vercel'],
    schema: { type: 'object', additionalProperties: false },
    activate() {
      return { handle(req) { seen.push(req); return { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify({ env: req.env, requestId: req.requestId }) }; } };
    },
  };
}
const extensionRoute = (env?: Record<string, unknown>) => ({ '/rec/*': { extension: 'rec', methods: ['GET'], ...(env ? { env } : {}) } });
const settings = { extensions: { rec: { version: '1' as const, config: {} } } };

test('a granted env binding on an extension route reaches ExtensionRequest.env', async t => {
  const root = await project(t, extensionRoute({ REGION: { env: 'AWS_REGION' }, MODE: { value: 'literal' } }), {}, settings);
  const seen: ExtensionRequest[] = [];
  const runtime = await createRuntime(root, { origin, extensions: [await recorder(root, seen)], permissions: await approveBindings(root), environment: { AWS_REGION: 'eu-west-1', OTHER: 'not-declared' } });
  t.after(() => runtime.close());
  await runtime.handle({ target: '/rec/x', requestId: 'req-granted' });
  assert.deepEqual({ ...seen[0]!.env }, { REGION: 'eu-west-1', MODE: 'literal' });
  assert.equal(seen[0]!.requestId, 'req-granted');
  assert.ok(Object.isFrozen(seen[0]!.env));
});

test('an ungranted env binding on an extension route is refused exactly like a function route', async t => {
  const env = { REGION: { env: 'AWS_REGION' } };
  const ext = await project(t, extensionRoute(env), {}, settings);
  const fn = await project(t, { '/f': { function: { source: 'f.mjs' }, env } }, { 'f.mjs': 'export default () => new Response("")' });
  const extError = await createRuntime(ext, { origin, extensions: [await recorder(ext, [])], environment: { AWS_REGION: 'eu-west-1' } }).then(() => undefined, (error: unknown) => error as Error);
  const fnError = await createRuntime(fn, { environment: { AWS_REGION: 'eu-west-1' } }).then(() => undefined, (error: unknown) => error as Error);
  assert.ok(extError && fnError);
  assert.match(extError.message, /Environment binding denied by operator policy: REGION reads AWS_REGION/);
  assert.equal(extError.message.replace('/rec/*', '<route>'), fnError.message.replace('/f', '<route>'));
});

test('a grant pinned to another revision still denies an extension route env binding', async t => {
  const root = await project(t, extensionRoute({ REGION: { env: 'AWS_REGION' } }), {}, settings);
  const permissions = { ...await approveBindings(root), projectSha256: 'f'.repeat(64) };
  await assert.rejects(createRuntime(root, { origin, extensions: [await recorder(root, [])], permissions, environment: { AWS_REGION: 'eu-west-1' } }), /denied by operator policy/);
});

test('secrets, guest middleware and parameters stay refused on an extension route', async t => {
  for (const extra of [
    { secrets: { KEY: { secret: 'API_KEY' } } },
    { middleware: [{ source: 'm.mjs' }] },
  ]) {
    const root = await project(t, { '/rec/*': { extension: 'rec', methods: ['GET'], ...extra } }, { 'm.mjs': 'export default (r,c,n)=>n()' }, settings);
    await assert.rejects(createRuntime(root, { origin, extensions: [await recorder(root, [])], permissions: await approveBindings(root), environment: { API_KEY: 'synthetic' } }), /Extension handlers cannot declare guest middleware, parameters or secrets/);
  }
});

test('an extension route with no env declared receives an empty env', async t => {
  const root = await project(t, extensionRoute(), {}, settings);
  const seen: ExtensionRequest[] = [];
  const runtime = await createRuntime(root, { origin, extensions: [await recorder(root, seen)], environment: { AWS_REGION: 'eu-west-1' } });
  t.after(() => runtime.close());
  await runtime.handle({ target: '/rec/x' });
  assert.deepEqual({ ...seen[0]!.env }, {});
  assert.match(seen[0]!.requestId, /^[0-9a-f-]{36}$/);
});

const echo = 'export default (_req, ctx) => Response.json({ requestId: ctx.requestId, type: typeof ctx.requestId })';
async function serve(t: TestContext, root: string, extensions?: RuntimeExtension[]) {
  const server = await startServer({ project: root, port: 0, log: () => {}, origin, ...(extensions ? { extensions } : {}) });
  t.after(() => server.close());
  return server;
}

for (const sandbox of [false, true]) {
  test(`the ${sandbox ? 'sandboxed' : 'trusted'} function context carries the response X-Request-Id as a plain string`, async t => {
    const root = await project(t, { '/id': { function: { source: 'f.mjs' }, ...(sandbox ? { sandbox: true, sandboxReason: 'test' } : {}) } }, { 'f.mjs': echo });
    const server = await serve(t, root);
    const response = await request(server, '/id');
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as { requestId: string; type: string };
    assert.equal(body.type, 'string');
    assert.equal(body.requestId, response.headers['x-request-id']);
  });
}

test('the extension request id equals the response X-Request-Id', async t => {
  const root = await project(t, extensionRoute(), {}, settings);
  const seen: ExtensionRequest[] = [];
  const server = await serve(t, root, [await recorder(root, seen)]);
  const response = await request(server, '/rec/x');
  assert.equal(response.status, 200);
  assert.equal(seen[0]!.requestId, response.headers['x-request-id']);
  assert.equal((JSON.parse(response.body) as { requestId: string }).requestId, response.headers['x-request-id']);
});

test('a caller-supplied request id reaches the function context; a malformed one is refused', async t => {
  const root = await project(t, { '/id': { function: { source: 'f.mjs' } } }, { 'f.mjs': echo });
  const runtime = await createRuntime(root);
  t.after(() => runtime.close());
  const result = await runtime.handle({ target: '/id', requestId: 'caller-id' });
  assert.equal((JSON.parse(Buffer.from(result.body as Uint8Array).toString()) as { requestId: string }).requestId, 'caller-id');
  await assert.rejects(runtime.handle({ target: '/id', requestId: 'x'.repeat(129) }), /Request id/);
});

test('loaded hooks receive (input, context) with a frozen copy of the generic hook context', async t => {
  const root = await project(t, {}, { 'hook.mjs': 'export default (input, context) => ({ input, context, frozen: Object.isFrozen(context) && Object.isFrozen(context.env) })' });
  const hooks = await loadExtensionHooks<'h'>({ h: 'hook.mjs' }, [{ name: 'h', kind: 'filter', description: 'x', inputSchema: { type: 'object' } }], { root });
  const env = { A: '1' };
  const output = hooks.h!({ x: 1 }, { requestId: 'r1', env }) as { input: unknown; context: { requestId: string; env: Record<string, string> }; frozen: boolean };
  assert.deepEqual(output.input, { x: 1 });
  assert.equal(output.context.requestId, 'r1');
  assert.deepEqual({ ...output.context.env }, { A: '1' });
  assert.equal(output.frozen, true);
  assert.equal(Object.isFrozen(env), false);
  assert.deepEqual(extensionHookContext(), { requestId: null, env: {} });
  assert.deepEqual(extensionHookContext({ requestId: 'r2', env: { B: '2' } }), { requestId: 'r2', env: { B: '2' } });
  assert.throws(() => hooks.h!({ x: 1 }, undefined as never), /Invalid extension hook context/);
});
