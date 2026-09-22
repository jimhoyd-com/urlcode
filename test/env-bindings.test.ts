// Host-overridable env bindings (issue #258): an `env` entry declaring both `value` and `env`
// keeps `value` as its default but lets the named process environment variable override it at
// request time when the grant exists and the variable is set and non-empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '../src/config.ts';
import { createRuntime } from '../src/runtime.ts';
import { project, request, approveBindings } from './helpers.ts';
import { startServer } from '../src/server.ts';
import type { TestContext } from 'node:test';
import type { Server } from '../src/server.ts';

async function app(t: TestContext, root: string, options: { permissions?: Awaited<ReturnType<typeof approveBindings>>; environment?: NodeJS.ProcessEnv } = {}): Promise<Server> {
  const server = await startServer({ project: root, port: 0, log: () => {}, ...options });
  t.after(() => server.close());
  return server;
}

test('schema accepts a literal value, a host-only reference, and a value+env default-with-override', () => {
  const routeWith = (env: unknown) => ({ version: '1' as const, routes: { '/x': { env, function: { source: 'x.mjs' } } } });
  validateDocument(routeWith({ GREETING: { value: 'Hello' } }));
  validateDocument(routeWith({ GREETING: { env: 'GREETING' } }));
  validateDocument(routeWith({ GREETING: { value: 'Hello', env: 'GREETING' } }));
});

test('schema rejects malformed value+env combinations', () => {
  const routeWith = (env: unknown) => ({ version: '1' as const, routes: { '/x': { env, function: { source: 'x.mjs' } } } });
  // Neither key.
  assert.throws(() => validateDocument(routeWith({ GREETING: {} })));
  // An unsupported third key alongside value/env (no `from`-style escape hatch).
  assert.throws(() => validateDocument(routeWith({ GREETING: { value: 'Hello', env: 'GREETING', from: 'host' } })));
  // env must still be a valid identifier even when paired with value.
  assert.throws(() => validateDocument(routeWith({ GREETING: { value: 'Hello', env: 'not a valid name' } })));
  // value must still be a string.
  assert.throws(() => validateDocument(routeWith({ GREETING: { value: 42, env: 'GREETING' } })));
});

test('a value+env binding still requires an operator grant for the env name', async t => {
  const root = await project(t, { '/hello': { function: { source: 'f.mjs' }, env: { GREETING: { value: 'Hello', env: 'GREETING' } } } }, { 'f.mjs': `export default (_r,{env}) => Response.json({greeting:env.GREETING});` });
  await assert.rejects(createRuntime(root, { environment: {} }), /denied by operator policy/);
});

test('a value+env binding falls back to the default when the granted variable is absent, and is overridden when present and non-empty', async t => {
  const root = await project(t, { '/hello': { function: { source: 'f.mjs' }, env: { GREETING: { value: 'Hello', env: 'GREETING' } } } }, { 'f.mjs': `export default (_r,{env}) => Response.json({greeting:env.GREETING});` });
  const permissions = await approveBindings(root);

  const withoutOverride = await app(t, root, { permissions, environment: {} });
  assert.deepEqual(JSON.parse((await request(withoutOverride, '/hello')).body), { greeting: 'Hello' });

  const withOverride = await app(t, root, { permissions, environment: { GREETING: 'Ahoy' } });
  assert.deepEqual(JSON.parse((await request(withOverride, '/hello')).body), { greeting: 'Ahoy' });

  // An empty string does not count as "set": the declared default still wins.
  const withEmptyOverride = await app(t, root, { permissions, environment: { GREETING: '' } });
  assert.deepEqual(JSON.parse((await request(withEmptyOverride, '/hello')).body), { greeting: 'Hello' });
});

test('an env-only binding is unaffected: still no default, still fails activation when unset', async t => {
  const root = await project(t, { '/hello': { function: { source: 'f.mjs' }, env: { GREETING: { env: 'GREETING' } } } }, { 'f.mjs': `export default (_r,{env}) => Response.json({greeting:env.GREETING});` });
  const permissions = await approveBindings(root);
  await assert.rejects(createRuntime(root, { permissions, environment: {} }), /Missing required environment binding/);
  const server = await app(t, root, { permissions, environment: { GREETING: 'Ahoy' } });
  assert.deepEqual(JSON.parse((await request(server, '/hello')).body), { greeting: 'Ahoy' });
});
