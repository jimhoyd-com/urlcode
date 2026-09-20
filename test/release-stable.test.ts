// Exercise GitHub release flags through the real publisher helper. All GitHub
// commands are mocked in a subprocess; these tests publish nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { identity } from '../scripts/release.ts';

interface Call { program: string; args: string[] }
async function publishFixture(directory: string, version: string, existing = false, corrupt = false, newer = false): Promise<{ status: number; output: string; calls: Call[] }> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-stable-test-'));
  try {
    const pkg = identity(directory === '.' ? '@jimhoyd/urlcode' : `@jimhoyd/urlcode-${directory.split('/')[1]}`, version, directory);
    await mkdir(join(root, 'candidate'));
    await writeFile(join(root, 'candidate', pkg.tarball), 'verified candidate bytes');
    const log = join(root, 'calls.jsonl');
    const preload = join(root, 'boundary.mjs');
    await writeFile(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const record = (program, args) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ program, args }) + '\\n');
childProcess.execFileSync = (program, args) => {
  record(program, args);
  if (program !== 'gh' || args[0] !== 'api' || !args.includes('--slurp')) throw new Error('Unexpected external read');
  return JSON.stringify([${JSON.stringify(newer ? [{ tag_name: 'v0.4.2', prerelease: false, assets: [] }] : existing ? [{ tag_name: pkg.tag, prerelease: pkg.prerelease, assets: [{ name: pkg.tarball }] }] : [])}]);
};
childProcess.spawnSync = (program, args) => {
  record(program, args);
  if (program !== 'gh' || args[0] !== 'release') throw new Error('Unexpected executable');
  if (args[1] === 'download') writeFileSync(join(args[args.indexOf('--dir') + 1], ${JSON.stringify(pkg.tarball)}), ${JSON.stringify(corrupt ? 'different bytes' : 'verified candidate bytes')});
  return { status: 0 };
};
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
`);
    const driver = join(root, 'publish.mjs');
    await writeFile(driver, `import { githubRelease } from ${JSON.stringify(new URL('../scripts/release.ts', import.meta.url).href)};\nawait githubRelease(${JSON.stringify(pkg)}, '${'a'.repeat(40)}', 'example/urlcode');\n`);
    let status = 0, output = '';
    try {
      output = execFileSync(process.execPath, ['--import', preload, driver], { cwd: root, encoding: 'utf8', timeout: 15000, stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' } });
    } catch (error) {
      const failure = error as { status: number | null; stdout?: string; stderr?: string };
      status = failure.status ?? -1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
    return { status, output, calls };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('stable core advances GitHub latest while stable extensions cannot replace its installer target', async () => {
  for (const directory of ['.', 'packages/ui', 'packages/auth', 'packages/admin']) {
    const result = await publishFixture(directory, '0.4.1');
    assert.equal(result.status, 0, result.output);
    const creation = result.calls.find(call => call.args[0] === 'release' && call.args[1] === 'create');
    assert(creation);
    assert(creation.args.includes('--prerelease=false'));
    assert(creation.args.includes(`--latest=${directory === '.'}`));
    assert.equal(identity('example', '0.4.1', directory).channel, 'latest');
  }
});

test('alpha core remains a prerelease and never changes GitHub latest', async () => {
  const result = await publishFixture('.', '0.4.2-alpha.1');
  assert.equal(result.status, 0, result.output);
  const creation = result.calls.find(call => call.args[1] === 'create');
  assert(creation);
  assert(creation.args.includes('--prerelease=true'));
  assert(creation.args.includes('--latest=false'));
});

test('stable core retry repairs latest only after identical asset verification', async () => {
  const result = await publishFixture('.', '0.4.1', true);
  assert.equal(result.status, 0, result.output);
  const download = result.calls.findIndex(call => call.args[1] === 'download');
  const edit = result.calls.findIndex(call => call.args[1] === 'edit');
  assert(download >= 0 && edit > download);
  assert(result.calls[edit]!.args.includes('--latest=true'));
  const mismatch = await publishFixture('.', '0.4.1', true, true);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.output, /refusing overwrite/);
  assert(!mismatch.calls.some(call => call.args[1] === 'edit'));
});

test('extension retries never promote the repository-wide latest pointer', async () => {
  const result = await publishFixture('packages/auth', '0.4.1', true);
  assert.equal(result.status, 0, result.output);
  assert(!result.calls.some(call => call.args[1] === 'edit'));
});


test('artifact-only releases cannot regress GitHub latest below a newer stable core', async () => {
  const result = await publishFixture('.', '0.4.1', false, false, true);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Refusing GitHub latest regression/);
  assert(!result.calls.some(call => call.args[0] === 'release'));
});
