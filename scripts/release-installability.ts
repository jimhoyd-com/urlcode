// Read-only npm propagation checks and a fresh consumer smoke test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCommand } from './release-npm.ts';

export interface PublishedPackage { name: string; version: string }
interface InstallabilityOptions {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}
class PropagationPending extends Error {}

/** Check the abbreviated metadata npm install reads, then the actual archive. */
export async function waitForInstallability(pkg: PublishedPackage, options: InstallabilityOptions = {}): Promise<void> {
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 60;
  const interval = options.intervalMs ?? 5000;
  assert(Number.isInteger(attempts) && attempts > 0 && attempts <= 120, 'Invalid propagation attempt limit');
  assert(Number.isFinite(interval) && interval >= 0 && interval <= 60000, 'Invalid propagation interval');
  const get = async (url: string, metadata = false) => {
    let response: Response;
    try {
      response = await request(url, { headers: metadata ? { accept: 'application/vnd.npm.install-v1+json' } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch (error) {
      throw new PropagationPending(`Registry request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new PropagationPending(`Registry returned HTTP ${response.status}`);
    }
    assert(response.ok, `Registry refused ${pkg.name}@${pkg.version}: HTTP ${response.status}`);
    return response;
  };
  let reason = 'Version missing from install metadata';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(interval);
    try {
      const metadata = await (await get(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, true)).json() as {
        versions?: Record<string, { name?: string; version?: string; dist?: { tarball?: string; integrity?: string } }>;
      };
      const version = metadata.versions?.[pkg.version];
      if (!version) throw new PropagationPending('Version missing from install metadata');
      assert.equal(version.name, pkg.name, 'Registry package identity mismatch');
      assert.equal(version.version, pkg.version, 'Registry version mismatch');
      const tarball = new URL(version.dist?.tarball ?? '');
      assert(tarball.protocol === 'https:' && tarball.hostname === 'registry.npmjs.org' && !tarball.username && !tarball.password && !tarball.port, 'Unexpected registry tarball URL');
      const integrity = version.dist?.integrity;
      assert(integrity && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity), 'Registry archive must have SHA512 integrity');
      const response = await get(tarball.href);
      let bytes: ArrayBuffer;
      try { bytes = await response.arrayBuffer(); }
      catch { throw new PropagationPending('Archive transfer interrupted'); }
      assert.equal(`sha512-${createHash('sha512').update(Buffer.from(bytes)).digest('base64')}`, integrity, 'Registry archive integrity mismatch; stop and investigate');
      return;
    } catch (error) {
      if (!(error instanceof PropagationPending)) throw error;
      reason = error.message;
    }
  }
  throw new Error(`${pkg.name}@${pkg.version} is not installable after ${attempts} checks: ${reason}. Inspect the original publication run; do not move its tag.`);
}

/** Install exact registry versions outside this checkout, without a warm npm cache. */
export async function verifyPublishedTrain(packages: readonly PublishedPackage[], options: {
  run?: (command: string, args: string[], cwd: string) => string;
} = {}): Promise<void> {
  assert.equal(packages.length, 4, 'Consumer smoke requires all four release packages');
  assert.deepEqual([...packages.map(pkg => pkg.name)].sort(), ['@jimhoyd/urlcode', '@jimhoyd/urlcode-admin', '@jimhoyd/urlcode-auth', '@jimhoyd/urlcode-ui']);
  const consumer = await mkdtemp(join(tmpdir(), 'urlcode-published-consumer-'));
  try {
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const run = options.run ?? ((command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 }));
    const npm = (args: string[]) => {
      const invocation = npmCommand([...args, '--registry=https://registry.npmjs.org', `--cache=${join(consumer, 'cache')}`]);
      return run(invocation.command, invocation.args, consumer);
    };
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online', ...packages.map(pkg => `${pkg.name}@${pkg.version}`)]);
    npm(['ls', '--all']);
    for (const pkg of packages) {
      const manifest = JSON.parse(await readFile(join(consumer, 'node_modules', ...pkg.name.split('/'), 'package.json'), 'utf8'));
      assert.equal(manifest.version, pkg.version, `Wrong installed version for ${pkg.name}`);
    }
    run(process.execPath, ['--input-type=module', '-e', `await Promise.all(${JSON.stringify(packages.map(pkg => pkg.name))}.map(name => import(name)));`], consumer);
    const output = run(process.execPath, [join(consumer, 'node_modules/@jimhoyd/urlcode/dist/cli.js'), 'init', 'site', '--with', 'auth,admin,ui'], consumer);
    assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)!).extensions, ['auth', 'admin', 'ui']);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}
