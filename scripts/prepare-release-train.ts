// Extend an already-built core candidate with workspace archives and test them
// together outside the monorepo. No tags, registry writes or credentials needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { inventory } from './release.ts';
import { verifyReleaseScaffold } from './release-scaffold.ts';
const directory = resolve('candidate');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.channel, 'candidate', 'Train preparation only extends a non-publishing candidate');
assert.equal(manifest.sourceCommit, process.env.URLCODE_SOURCE_SHA, 'Candidate must match the selected source');
assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
const packages = await inventory();
const npm = (args: string[], cwd = process.cwd()) => execFileSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const artifacts: { name: string; version: string; filename: string; integrity: string }[] = [];
for (const pkg of packages) {
  if (pkg.directory !== '.') npm(['pack', '--workspace', pkg.name, '--ignore-scripts', '--pack-destination', directory]);
  const bytes = await readFile(join(directory, pkg.tarball));
  artifacts.push({ name: pkg.name, version: pkg.version, filename: pkg.tarball,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` });
  manifest.artifacts[pkg.tarball] = createHash('sha256').update(bytes).digest('hex');
}
const consumer = await mkdtemp(join(tmpdir(), 'urlcode-release-train-'));
try {
  const root = await realpath(process.cwd()), actual = await realpath(consumer);
  assert(!actual.startsWith(root + sep), 'Consumer must be outside the monorepo');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...artifacts.map(pkg => join(directory, pkg.filename))], consumer);
  npm(['ls', '--all'], consumer); // Fail unmet or incompatible peer constraints.
  for (const pkg of artifacts) {
    const installed = join(consumer, 'node_modules', ...pkg.name.split('/'));
    assert(!(await realpath(installed)).startsWith(root + sep), 'Installed package resolved to workspace source');
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.equal(installedManifest.version, pkg.version);
  }
  verifyReleaseScaffold(consumer, (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 60000 }));
  // Resolve installed public exports, not source aliases.
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "await Promise.all(['@jimhoyd/urlcode','@jimhoyd/urlcode-ui','@jimhoyd/urlcode-auth','@jimhoyd/urlcode-admin'].map(name => import(name)));"],
  { cwd: consumer, stdio: 'inherit', timeout: 60000 });
} finally {
  await rm(consumer, { recursive: true, force: true });
}
// Include the measured Homebrew formula in the signed, reusable bundle.
execFileSync(process.execPath, ['scripts/render-homebrew.ts', '--tarball', join(directory, packages[0]!.tarball)], { stdio: 'inherit' });
manifest.artifacts['urlcode.rb'] = createHash('sha256').update(await readFile(join(directory, 'urlcode.rb'))).digest('hex');
const train = JSON.stringify({ sourceCommit: manifest.sourceCommit, packages: artifacts,
  validation: 'isolated install, peer tree, public imports and auth/admin/ui scaffold; no publication or live host test' }, null, 2) + '\n';
await writeFile(join(directory, 'train.json'), train, { flag: 'wx' });
manifest.artifacts['train.json'] = createHash('sha256').update(train).digest('hex');
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(directory, 'SHA256SUMS'), Object.entries(manifest.artifacts).sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`).join('\n') + '\n');
console.log(`Verified ${artifacts.length} candidate archives together; no packages published.`);
