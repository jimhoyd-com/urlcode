import test from 'node:test';
import assert from 'node:assert/strict';
import { readPolicyFromEnvironment, resolveOrigin, lazyRuntime } from '../packages/core/src/adapters.ts';
import { ConfigError } from '../packages/core/src/errors.ts';

const sha = 'a'.repeat(64);
test('URLCODE_POLICY is parsed and validated like the operator policy file', () => {
  assert.equal(readPolicyFromEnvironment({}), undefined);
  assert.equal(readPolicyFromEnvironment({ URLCODE_POLICY: '' }), undefined);
  const policy = { version: 1, projectSha256: sha, routes: { '/r': { env: ['TOKEN'], egress: { proxy: ['https://api.example.com'] } } } };
  assert.deepEqual(readPolicyFromEnvironment({ URLCODE_POLICY: JSON.stringify(policy) }), policy);
  assert.throws(() => readPolicyFromEnvironment({ URLCODE_POLICY: '{not json' }), (e: unknown) => e instanceof ConfigError && /not valid JSON/.test(e.message));
  assert.throws(() => readPolicyFromEnvironment({ URLCODE_POLICY: JSON.stringify({ version: 2, projectSha256: sha, routes: {} }) }), /version 1/);
  assert.throws(() => readPolicyFromEnvironment({ URLCODE_POLICY: JSON.stringify({ ...policy, routes: { r: {} } }) }), /Invalid route grant/);
  assert.throws(() => readPolicyFromEnvironment({ URLCODE_POLICY: JSON.stringify({ ...policy, routes: { '/r': { fs: [] } } }) }), /Unsupported policy capability/);
  assert.throws(() => readPolicyFromEnvironment({ URLCODE_POLICY: JSON.stringify({ ...policy, routes: { '/r': { egress: { proxy: ['https://api.example.com/path'] } } } }) }), /exact HTTPS origins/);
  assert.throws(() => readPolicyFromEnvironment({ URLCODE_POLICY: JSON.stringify({ ...policy, routes: { '/r': { env: ['1bad'] } } }) }), /Invalid binding grant/);
});

test('origin resolution prefers the explicit value, then URLCODE_ORIGIN, then platform variables', () => {
  assert.equal(resolveOrigin('https://given.example', { URLCODE_ORIGIN: 'https://env.example' }, ['VERCEL_URL']), 'https://given.example');
  assert.equal(resolveOrigin(undefined, { URLCODE_ORIGIN: 'https://env.example', VERCEL_URL: 'x.vercel.app' }, ['VERCEL_URL']), 'https://env.example');
  assert.equal(resolveOrigin(undefined, { VERCEL_URL: 'x.vercel.app' }, ['VERCEL_URL']), 'https://x.vercel.app');
  assert.equal(resolveOrigin(undefined, {}, ['VERCEL_URL']), undefined);
});

test('lazyRuntime caches a success and retries after a failure', async () => {
  let calls = 0;
  const activate = lazyRuntime(async () => { if (++calls === 1) throw new Error('first'); return calls; });
  await assert.rejects(activate(), /first/);
  assert.equal(await activate(), 2); assert.equal(await activate(), 2); assert.equal(calls, 2);
});
