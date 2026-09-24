import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { waitForInstallability } from '../scripts/release-installability.ts';

const pkg = { name: '@jimhoyd/urlcode', version: '0.4.0-alpha.3' };
const archive = Buffer.from('synthetic package archive');
const metadata = () => new Response(JSON.stringify({ versions: { [pkg.version]: { ...pkg, dist: {
  tarball: 'https://registry.npmjs.org/@jimhoyd/urlcode/-/urlcode-0.4.0-alpha.3.tgz',
  integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
} } } }));
const sequence = (responses: Array<Response | Error>, calls: RequestInit[] = []): typeof fetch => async (_url, init) => {
  calls.push(init ?? {});
  const next = responses.shift();
  assert(next, 'Unexpected additional request');
  if (next instanceof Error) throw next;
  return next;
};

test('waits for npm install metadata and tarball propagation, not just version endpoint', async () => {
  const calls: RequestInit[] = [], sleeps: number[] = [];
  await waitForInstallability(pkg, { fetch: sequence([
    new Response(JSON.stringify({ versions: {} })), metadata(), new Response('', { status: 404 }),
    metadata(), new Response(archive),
  ], calls), sleep: async ms => { sleeps.push(ms); }, attempts: 3, intervalMs: 7 });
  assert.deepEqual(sleeps, [7, 7]);
  assert.equal((calls[0]!.headers as Record<string, string>).accept, 'application/vnd.npm.install-v1+json');
});

test('transient registry failures have a bounded retry budget and preserve cause', async () => {
  let count = 0;
  await assert.rejects(waitForInstallability(pkg, { fetch: async () => { count++; return new Response('', { status: 503 }); },
    sleep: async () => {}, attempts: 2 }), /after 2 checks: Registry returned HTTP 503/);
  assert.equal(count, 2);
});

test('authentication errors fail immediately, not as propagation', async () => {
  await assert.rejects(waitForInstallability(pkg, { fetch: sequence([new Response('', { status: 401 })]),
    sleep: async () => { assert.fail('Must not retry authentication'); } }), /HTTP 401/);
});

test('changed archive bytes fail immediately even when metadata says version exists', async () => {
  await assert.rejects(waitForInstallability(pkg, { fetch: sequence([metadata(), new Response('different archive')]),
    sleep: async () => { assert.fail('Must not retry integrity mismatch'); } }), /integrity mismatch/);
});

test('transient network failure can recover without changing the selected version', async () => {
  await waitForInstallability(pkg, { fetch: sequence([new TypeError('fetch failed'), metadata(), new Response(archive)]),
    sleep: async () => {}, attempts: 2 });
});

