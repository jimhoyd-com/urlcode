import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_PACKAGES = [
  '@jimhoyd/urlcode',
  '@jimhoyd/urlcode-ui',
  '@jimhoyd/urlcode-auth',
  '@jimhoyd/urlcode-admin',
  '@jimhoyd/urlcode-store',
  '@jimhoyd/urlcode-forms',
] as const;

interface SourceManifest {
  packages: { name: string; filename: string }[];
}

/** Validate the small part of pack-sources output CI depends on before using it. */
export function assertSourceManifest(manifest: SourceManifest, directory: string, exists: (path: string) => boolean = existsSync): void {
  if (JSON.stringify(manifest.packages.map(pkg => pkg.name)) !== JSON.stringify(SOURCE_PACKAGES)) {
    throw new Error(`unexpected packages ${JSON.stringify(manifest.packages)}`);
  }
  for (const pkg of manifest.packages) {
    if (!exists(join(directory, pkg.filename))) throw new Error(`missing ${pkg.filename}`);
  }
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' });
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function archive(directory: string): string {
  const name = output('npm', ['pack', '--ignore-scripts', '--pack-destination', directory]);
  return join(directory, name.split(/\r?\n/).at(-1)!);
}

/**
 * Release shipping proof kept out of workflow YAML so its file and archive
 * invariants are unit-testable. This intentionally starts after plain `npm ci`:
 * the workflow owns that lifecycle state because it is itself part of the proof.
 */
export function runBuildFidelity(): void {
  const revision = output('git', ['rev-parse', 'HEAD']);
  const directory = join(process.env.RUNNER_TEMP ?? '/tmp', 'pack-sources');
  run('node', ['scripts/pack-sources.mjs', '--revision', revision, '--out', directory, '--offline']);
  assertSourceManifest(JSON.parse(readFileSync(join(directory, 'source-manifest.json'), 'utf8')) as SourceManifest, directory);

  run('npm', ['run', 'build']);
  cpSync('dist', 'first', { recursive: true });
  run('npm', ['run', 'build']);
  run('diff', ['-r', 'first', 'dist']);

  mkdirSync('a');
  mkdirSync('b');
  const first = archive('a');
  const second = archive('b');
  run('sha256sum', [first, second]);
  run('cmp', [first, second]);
}

if (import.meta.main) runBuildFidelity();
