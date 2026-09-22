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

test('consumer smoke accepts the full inventory record the coordinator passes', async () => {
  const { verifyPublishedTrain } = await import('../scripts/release-installability.ts');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const record = { ...pkg, directory: '.', tag: `v${pkg.version}`, channel: 'latest', prerelease: false, tarball: 'jimhoyd-urlcode.tgz', peers: { typescript: '>=6' } };
  await verifyPublishedTrain([record], { run: (_command, args, cwd) => {
    if (args.includes('install')) {
      const path = join(cwd, 'node_modules', ...pkg.name.split('/'));
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify(pkg));
    }
    return args.includes('init') ? JSON.stringify({ dependencies: [{ name: '@jimhoyd/urlcode' }] }) : '';
  } });
  await assert.rejects(verifyPublishedTrain([record, { ...record, name: '@jimhoyd/urlcode-auth' }]), /only the core npm release/);
});

test('published core uses an exact registry version, an empty cache and an isolated consumer', async () => {
  const { verifyPublishedTrain } = await import('../scripts/release-installability.ts');
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const packages = [pkg];
  const calls: string[][] = [];
  let directory = '';
  await verifyPublishedTrain(packages, { run: (command, args, cwd) => {
    directory = cwd;
    const normalized = command === process.execPath && args[0] === process.env.npm_execpath ? args.slice(1) : args;
    calls.push([command, ...normalized]);
    assert(!cwd.startsWith(process.cwd()));
    if (normalized[0] === 'install') {
      assert(args.includes(`--cache=${join(cwd, 'cache')}`));
      assert(!existsSync(join(cwd, 'cache')), 'Cache must start empty');
      for (const p of packages) {
        assert(args.includes(`${p.name}@${p.version}`));
        const path = join(cwd, 'node_modules', ...p.name.split('/'));
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'package.json'), JSON.stringify(p));
      }
    }
    if (args.includes('init')) {
      return args.includes('--with')
        ? JSON.stringify({ extensions: args[args.indexOf('--with') + 1]!.split(',') })
        : JSON.stringify({ dependencies: [{ name: '@jimhoyd/urlcode' }] });
    }
    return '';
  } });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1]!.slice(1, 3), ['ls', '--all']);
  assert.match(calls[2]!.join(' '), /import\(name\)/);
  assert(calls[3]!.includes('--manifest'));
  assert(!existsSync(directory), 'Consumer should be removed');
});
