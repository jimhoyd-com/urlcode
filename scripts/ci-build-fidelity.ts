// dist/ is never committed, so a release must be reproducible from its commit: build and pack everything with the
// real release packer twice, from clean builds, and require byte-identical tarballs and pins.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { releasePack } from './release-pack.ts';
import { npmCommand } from './npm-command.ts';
import { repositoryRoot } from './workspaces.ts';

/** The SHA256SUMS lines that must be reproducible: every tarball and the pins (the SBOM carries a timestamp). */
export async function reproducible(directory: string): Promise<string[]> {
  return (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n').filter(line => /\s(?:\S+\.tgz|addons\.json)$/.test(line)).sort();
}
function build(): void {
  for (const args of [['run', 'build'], ['run', 'build:addons']]) { const npm = npmCommand(args); execFileSync(npm.command, npm.args, { cwd: repositoryRoot, stdio: 'inherit' }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-fidelity-'));
  build(); await releasePack(join(root, 'first'));
  build(); await releasePack(join(root, 'second'));
  const [first, second] = [await reproducible(join(root, 'first')), await reproducible(join(root, 'second'))];
  assert(first.length > 1, 'No tarballs were packed');
  assert.deepEqual(second, first, 'Two clean builds packed different bytes');
  process.stdout.write(`Reproducible: ${first.length} files\n${first.join('\n')}\n`);
}
