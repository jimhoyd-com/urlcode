// Host-overridable env bindings (issue #258): an `env` entry may declare an optional `default`.
// `value`-only bindings stay plain literals, never touched by the grant or the host environment
// (so they stay reviewable as literals). `env`-only and `env`+`default` bindings both still
// require an operator grant to read the host variable; without a grant, a declared `default` is
// used with no host read attempted, and only a binding with no `default` still fails to compile.
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

test('schema accepts a literal value, a host-only reference, and a host reference with a default', () => {
  const routeWith = (env: unknown) => ({ version: '1' as const, routes: { '/x': { env, function: { source: 'x.mjs' } } } });
  validateDocument(routeWith({ GREETING: { value: 'Hello' } }));
  validateDocument(routeWith({ GREETING: { env: 'GREETING' } }));
  validateDocument(routeWith({ GREETING: { env: 'GREETING', default: 'Hello' } }));
});

test('schema rejects malformed shapes', () => {
  const routeWith = (env: unknown) => ({ version: '1' as const, routes: { '/x': { env, function: { source: 'x.mjs' } } } });
  // Neither key.
  assert.throws(() => validateDocument(routeWith({ GREETING: {} })));
  // `value` combined with `env` is refused: a literal-shaped binding must stay a plain literal,
  // never silently overridable, so a reviewer can trust `value` alone means "reviewable literal".
  assert.throws(() => validateDocument(routeWith({ GREETING: { value: 'Hello', env: 'GREETING' } })));
  // No unsupported extra keys.
  assert.throws(() => validateDocument(routeWith({ GREETING: { env: 'GREETING', default: 'Hello', from: 'host' } })));
  // env must still be a valid identifier even when paired with a default.
  assert.throws(() => validateDocument(routeWith({ GREETING: { env: 'not a valid name', default: 'Hello' } })));
  // default must still be a string.
  assert.throws(() => validateDocument(routeWith({ GREETING: { env: 'GREETING', default: 42 } })));
});

test('an env binding with no default still requires an operator grant and fails compilation without one', async t => {
  const root = await project(t, { '/hello': { function: { source: 'f.mjs' }, env: { GREETING: { env: 'GREETING' } } } }, { 'f.mjs': `export default (_r,{env}) => Response.json({greeting:env.GREETING});` });
  await assert.rejects(createRuntime(root, { environment: {} }), /denied by operator policy/);
});

test('an env binding with a default is usable with no grant at all: it degrades to the literal default, no host read attempted', async t => {
  const root = await project(t, { '/hello': { function: { source: 'f.mjs' }, env: { GREETING: { env: 'GREETING', default: 'Hello' } } } }, { 'f.mjs': `export default (_r,{env}) => Response.json({greeting:env.GREETING});` });
  // No permissions granted at all, and the host var is even set — it must never be read without a grant.
  const server = await app(t, root, { environment: { GREETING: 'Ahoy' } });
  assert.deepEqual(JSON.parse((await request(server, '/hello')).body), { greeting: 'Hello' });
});

test('once granted, an env binding with a default prefers the host value when set, falls back to the default otherwise', async t => {
  const root = await project(t, { '/hello': { function: { source: 'f.mjs' }, env: { GREETING: { env: 'GREETING', default: 'Hello' } } } }, { 'f.mjs': `export default (_r,{env}) => Response.json({greeting:env.GREETING});` });
  const permissions = await approveBindings(root);

  const withoutOverride = await app(t, root, { permissions, environment: {} });
  assert.deepEqual(JSON.parse((await request(withoutOverride, '/hello')).body), { greeting: 'Hello' });

  const withOverride = await app(t, root, { permissions, environment: { GREETING: 'Ahoy' } });
  assert.deepEqual(JSON.parse((await request(withOverride, '/hello')).body), { greeting: 'Ahoy' });

  // An empty string does not count as "set" when a default exists: the default still wins.
  const withEmptyOverride = await app(t, root, { permissions, environment: { GREETING: '' } });
  assert.deepEqual(JSON.parse((await request(withEmptyOverride, '/hello')).body), { greeting: 'Hello' });
});

test('an env-only binding with no default is unaffected: still fails activation when unset, even when granted', async t => {
  const root = await project(t, { '/hello': { function: { source: 'f.mjs' }, env: { GREETING: { env: 'GREETING' } } } }, { 'f.mjs': `export default (_r,{env}) => Response.json({greeting:env.GREETING});` });
  const permissions = await approveBindings(root);
  await assert.rejects(createRuntime(root, { permissions, environment: {} }), /Missing required environment binding/);
  const server = await app(t, root, { permissions, environment: { GREETING: 'Ahoy' } });
  assert.deepEqual(JSON.parse((await request(server, '/hello')).body), { greeting: 'Ahoy' });
});
