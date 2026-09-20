// Exercise the real restoration boundary with local fake GitHub responses.
// Cryptographic verification is mocked; no network, build or publication occurs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { identity } from '../scripts/release.ts';

const helper = new URL('../scripts/release-artifacts.ts', import.meta.url).href;
const sha = 'a'.repeat(40);
const packages = ['.', 'packages/ui', 'packages/auth', 'packages/admin'].map(directory => identity(
  directory === '.' ? '@jimhoyd/urlcode' : `@jimhoyd/urlcode-${directory.split('/')[1]}`, '0.4.0-alpha.4', directory));
const pkg = packages[0]!;
const artifactName = `release-${pkg.tarball}-${sha}`;
type Scenario = 'missing' | 'durable' | 'retained' | 'corrupt' | 'wrong-run' | 'unsigned' | 'same-run-rebuild';
interface Call { program: string; args: string[] }
async function scenario(kind: Scenario): Promise<{ status: number; output: string; calls: Call[]; files: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-recovery-test-'));
  try {
    const source = join(root, 'original');
    await mkdir(source);
    const assets: Record<string, Buffer> = Object.fromEntries(packages.map(item => [item.tarball, Buffer.from(`Original ${item.name} bytes`)]));
    assets['sbom.cdx.json'] = Buffer.from('{}');
    assets['urlcode.rb'] = Buffer.from('measured formula');
    assets['train.json'] = Buffer.from(JSON.stringify({ sourceCommit: sha, packages: packages.map(item => ({
      name: item.name, version: item.version, filename: item.tarball,
      integrity: `sha512-${createHash('sha512').update(assets[item.tarball]!).digest('base64')}`,
      channel: item.channel, peerDependencies: item.peers,
    })) }));
    const digests = Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
    assets['manifest.json'] = Buffer.from(JSON.stringify({ sourceCommit: sha, candidateRun: kind === 'wrong-run' ? '203' : '202', channel: 'candidate', artifacts: digests }));
    const candidateManifestSha256 = createHash('sha256').update(assets['manifest.json']).digest('hex');
    if (kind === 'same-run-rebuild') assets['manifest.json'] = Buffer.from(JSON.stringify({ ...JSON.parse(assets['manifest.json'].toString()), buildAttempt: 2 }));
    assets['SHA256SUMS'] = Buffer.from(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n');
    for (const [name, bytes] of Object.entries(assets)) await writeFile(join(source, name), bytes);
    if (kind === 'corrupt') await writeFile(join(source, pkg.tarball), 'replacement bytes');
    const log = join(root, 'calls.jsonl');
    const preload = join(root, 'boundary.mjs');
    await writeFile(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, cpSync } from 'node:fs';
const kind = ${JSON.stringify(kind)};
const record = (program, args) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ program, args }) + '\\n');
const reply = (value, options) => options?.encoding ? value : Buffer.from(value);
childProcess.execFileSync = (program, args, options) => {
  record(program, args);
  if (program !== 'gh') throw new Error('No build or publication executable allowed: ' + program);
  if (args[0] === 'attestation' && args[1] === 'verify') {
    if (kind === 'unsigned') throw new Error('Fixture provenance verification refused');
    return reply('', options);
  }
  if ((args[0] === 'release' || args[0] === 'run') && args[1] === 'download') {
    const target = args[args.indexOf('--dir') + 1];
    cpSync(${JSON.stringify(source)}, target, { recursive: true });
    return reply('', options);
  }
  if (args[0] !== 'api' || args.includes('--method') || args.includes('-X')) throw new Error('Mutation forbidden: ' + JSON.stringify(args));
  const endpoint = args.find(arg => arg.startsWith('repos/'));
  let body;
  if (endpoint.includes('/git/ref/tags/')) body = { object: { type: 'tag', sha: 'tag-object' } };
  else if (endpoint.endsWith('/git/tags/tag-object')) body = ${JSON.stringify({ tag: pkg.tag, object: { type: 'commit', sha }, message: JSON.stringify({ sourceCommit: sha, candidateRun: 202, candidateManifestSha256 }) })};
  else if (endpoint.includes('/actions/runs/900/artifacts')) body = { artifacts: kind === 'retained' ? [{ name: ${JSON.stringify(artifactName)}, expired: false }] : [{ name: ${JSON.stringify(artifactName)}, expired: true }] };
  else if (endpoint.includes('/releases?')) body = [kind === 'missing' ? [] : [{ tag_name: ${JSON.stringify(pkg.tag)} }]];
  else throw new Error('Unexpected GitHub lookup; retries must not select a new candidate: ' + endpoint);
  return reply(JSON.stringify(body), options);
};
syncBuiltinESMExports();
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
`);
    const driver = join(root, 'restore.mjs');
    await writeFile(driver, `import { restoreReleaseArtifacts } from ${JSON.stringify(helper)};\nconst result = await restoreReleaseArtifacts(${JSON.stringify(pkg)}, ${JSON.stringify(sha)}, 'example/urlcode', ${JSON.stringify(packages)});\nconsole.log('RESULT ' + JSON.stringify(result));\n`);
    let status = 0, output = '';
    try {
      output = execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, driver], { cwd: root, encoding: 'utf8', timeout: 15000, stdio: 'pipe',
        env: { ...process.env, GITHUB_RUN_ID: '900', GITHUB_RUN_ATTEMPT: '2', NODE_OPTIONS: '' } });
    } catch (error) {
      const failure = error as { status: number | null; stdout?: string; stderr?: string };
      status = failure.status ?? -1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    const calls = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
    return { status, output, calls, files: Object.keys(assets) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('retry with expired retained artifacts and no durable release refuses any fallback build or candidate selection', async () => {
  const result = await scenario('missing');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Refusing to rebuild or select a new candidate/);
  assert(result.calls.every(call => call.program === 'gh' && call.args[0] === 'api'));
  assert(!result.calls.some(call => call.args.some(arg => arg.includes('/workflows/') || arg.includes('/runs/202'))));
  assert.doesNotMatch(result.output, /RESULT /);
});

test('durable release recovery verifies every pinned original asset before returning restored', async () => {
  const result = await scenario('durable');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /RESULT \{"restored":true,/);
  const download = result.calls.find(call => call.args[0] === 'release' && call.args[1] === 'download');
  assert.equal(download?.args[2], pkg.tag);
  assert(!result.calls.some(call => call.args[0] === 'run'));
  const verification = result.calls.filter(call => call.args[0] === 'attestation');
  assert.equal(verification.length, result.files.length);
  for (const call of verification) {
    assert.equal(call.args[call.args.indexOf('--repo') + 1], 'example/urlcode');
    assert.equal(call.args[call.args.indexOf('--signer-workflow') + 1], 'example/urlcode/.github/workflows/candidate.yml');
    assert.equal(call.args[call.args.indexOf('--source-digest') + 1], sha);
    assert(call.args.includes('--deny-self-hosted-runners'));
  }
});

test('same-run retained artifact recovery skips durable lookup and still verifies provenance', async () => {
  const result = await scenario('retained');
  assert.equal(result.status, 0, result.output);
  const download = result.calls.find(call => call.args[0] === 'run' && call.args[1] === 'download');
  assert.equal(download?.args[2], '900');
  assert.equal(download?.args[download.args.indexOf('--name') + 1], artifactName);
  assert(!result.calls.some(call => call.args.some(arg => arg.includes('/releases?'))));
  assert.equal(result.calls.filter(call => call.args[0] === 'attestation').length, result.files.length);
});

for (const [kind, expected] of [['corrupt', /hash mismatch/], ['wrong-run', /immutable tag pin/], ['same-run-rebuild', /rerun cannot replace approved bytes/], ['unsigned', /provenance verification refused/]] as const) {
  test(`durable recovery refuses ${kind} assets without reporting success`, async () => {
    const result = await scenario(kind);
    assert.notEqual(result.status, 0);
    assert.match(result.output, expected);
    assert.doesNotMatch(result.output, /RESULT /);
    if (kind !== 'unsigned') assert(!result.calls.some(call => call.args[0] === 'attestation'));
  });
}
