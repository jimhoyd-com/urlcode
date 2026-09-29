// Packs core and every add-on with npm pack, and writes the addons.json that pins each add-on tarball by sha512.
// The integration test and CI pin `file:` tarballs; the release passes the GitHub Release download base instead.
//
//   node scripts/pack-addons.ts <out-directory> [--site <directory> --with a,b [--example] [--ack x:y]]
//
// With --site it also creates a site from the packed runtime and adds the named extensions to it (the CI action job).
//
// It packs with --ignore-scripts, like every pack in this repository, so it never builds: it packs the dist/ already
// there. Build core (`npm run build`) and the add-ons (`node scripts/workspaces.ts run build`) first; a package whose
// exports or bin name a file that is not there is refused before anything is packed (#960).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addons, repositoryRoot } from './workspaces.ts';
import { npmCommand } from './npm-command.ts';
import { withPublishedManifest } from './published-manifest.mjs';

export interface PackedAddons { core: string; tarballs: Record<string, string>; manifest: string }
const npm = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string => { const command = npmCommand(args); return execFileSync(command.command, command.args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); };
export const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

const targets = (value: unknown): string[] => typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];

/** The files a package's `exports` and `bin` name that are not in its directory: a package packed so would install but not load. */
export async function missingEntryFiles(directory: string): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { exports?: unknown; bin?: unknown };
  const missing: string[] = [];
  for (const target of new Set([...targets(pkg.exports), ...targets(pkg.bin)])) {
    if (target.includes('*')) continue;
    if (await access(join(directory, target)).then(() => false, () => true)) missing.push(target);
  }
  return missing;
}

/** Refuses, before anything is packed, packages whose entry files are missing, naming each file and the build that makes it. */
export async function assertBuilt(packages: { packageName: string; directory: string; build: string }[]): Promise<void> {
  const problems: string[] = [];
  for (const { packageName, directory, build } of packages) {
    const missing = await missingEntryFiles(directory);
    if (missing.length) problems.push(`${packageName} (${relative(repositoryRoot, directory) || '.'}) is not built: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing; build it with \`${build}\``);
  }
  if (problems.length) throw new Error(`Refusing to pack unbuilt packages; they would install but fail to load:\n- ${problems.join('\n- ')}\nBuild them, then pack again.`);
}

/**
 * `urlBase` (for example https://github.com/jimhoyd-com/urlcode/releases/download/v1.2.3) replaces the local `file:`
 * URLs. `pinCore` writes the manifest into core's dist/addons.json before core is packed, as a release does: the
 * packed core then carries the pins of exactly these add-on bytes.
 */
export async function packAddons(out: string, { urlBase, pinCore = false }: { urlBase?: string; pinCore?: boolean } = {}): Promise<PackedAddons> {
  const all = await addons();
  await assertBuilt([{ packageName: '@jimhoyd/urlcode', directory: repositoryRoot, build: 'npm run build' }, ...all.map(addon => ({ packageName: addon.packageName, directory: addon.directory, build: 'node scripts/workspaces.ts run build' }))]);
  await mkdir(out, { recursive: true });
  const pack = (dir: string): string => join(out, (JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', out], dir)) as { filename: string }[])[0]!.filename);
  const version = (JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const tarballs: Record<string, string> = {}, entries: Record<string, unknown> = {};
  for (const addon of all) {
    if (addon.version !== version) throw new Error(`${addon.packageName} is ${addon.version}; every add-on must share core's version ${version}`);
    const file = tarballs[addon.name] = pack(addon.directory);
    const name = file.slice(out.length + 1);
    entries[addon.name] = { kind: addon.kind, package: addon.packageName, description: addon.description, requires: addon.requires, ...(addon.uses.length ? { uses: addon.uses } : {}), url: urlBase ? `${urlBase}/${name}` : `file:${file}`, integrity: integrity(await readFile(file)) };
  }
  const manifest = join(out, 'addons.json');
  const text = JSON.stringify({ format: 1, version, addons: entries }, null, 2) + '\n';
  await writeFile(manifest, text);
  if (pinCore) await writeFile(join(repositoryRoot, 'dist', 'addons.json'), text);
  // Core's published manifest drops its development-only `prepare` build hook.
  return { core: await withPublishedManifest(repositoryRoot, () => pack(repositoryRoot)), tarballs, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), option = (name: string): string | undefined => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const out = resolve(args[0] ?? 'packed'), site = option('--site');
  // A site gets a core that pins these tarballs, exactly as a released core pins its release's add-ons.
  const packed = await packAddons(out, { pinCore: site !== undefined });
  process.stdout.write(JSON.stringify(packed, null, 2) + '\n');
  if (site) {
    const cli = join(repositoryRoot, 'dist', 'cli.js'), env = { ...process.env, URLCODE_ADDONS: packed.manifest };
    const run = (argv: string[], cwd: string): void => { execFileSync(process.execPath, [cli, ...argv], { cwd, env, stdio: 'inherit' }); };
    run(['init', resolve(site)], repositoryRoot);
    const file = join(resolve(site), 'package.json'), pkg = JSON.parse(await readFile(file, 'utf8')) as { dependencies: Record<string, string> };
    pkg.dependencies['@jimhoyd/urlcode'] = `file:${packed.core}`;
    await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
    const names = (option('--with') ?? '').split(',').filter(Boolean), ack = option('--ack');
    if (names.length) run(['extensions', 'add', ...names, ...(args.includes('--example') ? ['--example'] : []), ...(ack ? ['--ack', ack] : [])], resolve(site));
    else npm(['install', '--ignore-scripts'], resolve(site), env);
  }
}
