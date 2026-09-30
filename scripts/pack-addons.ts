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
//
// The core tarball always carries the addons.json written beside it, never the build's development manifest with its
// `file:` links into this checkout (#1002). Every package is packed from a staged copy with its published package.json
// (no `development` export conditions, #1056), so the checkout is not touched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addons, repositoryRoot } from './workspaces.ts';
import { npmCommand } from './npm-command.ts';
import { publishedManifest } from './published-manifest.mjs';
import { parsePackJson } from './pack-json.ts';

export interface PackedAddons { core: string; tarballs: Record<string, string>; manifest: string }
const npm = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string => { const command = npmCommand(args); return execFileSync(command.command, command.args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); };
export const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

const targets = (value: unknown): string[] => typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];

/** The files a package's `exports` and `bin` name that are not in its directory: a package packed so would install but not load. */
export async function missingEntryFiles(directory: string): Promise<string[]> {
  const pkg = JSON.parse(publishedManifest(await readFile(join(directory, 'package.json'), 'utf8'))) as { exports?: unknown; bin?: unknown };
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

/** The `dist/addons.json` a packed core tarball carries, as text. */
export const shippedManifest = (tarball: string): string => execFileSync('tar', ['-xOzf', tarball, 'package/dist/addons.json'], { encoding: 'utf8' });

/**
 * What is wrong with an add-on manifest a core tarball carries: a development manifest (a `file:` source directory,
 * no integrity) names paths on the machine that built it and pins nothing, so it must never ship (#1002).
 */
export function shippedManifestProblems(text: string): string[] {
  const manifest = JSON.parse(text) as { addons?: Record<string, { url?: unknown; integrity?: unknown }> };
  return Object.entries(manifest.addons ?? {}).flatMap(([name, pin]) => typeof pin.integrity === 'string' && /^sha512-/.test(pin.integrity) && typeof pin.url === 'string' && (/^https:\/\//.test(pin.url) || /^file:.*\.tgz$/.test(pin.url))
    ? [] : [`${name} is not pinned: ${String(pin.url)} with integrity ${String(pin.integrity)} is a development link`]);
}

/**
 * Packs the package in `directory` into `out` from a staged copy, using npm's file selection with its
 * published package.json (scripts/published-manifest.mjs) and each of `replace` (a packed path to its contents), so
 * `directory` is never written. Returns the tarball path.
 */
export async function packPublished(directory: string, out: string, replace: Record<string, string> = {}): Promise<string> {
  const stage = await mkdtemp(join(tmpdir(), 'urlcode-pack-stage-'));
  try {
    // npm 10 runs prepare even for `pack --dry-run --ignore-scripts`. Sanitize the
    // staged manifest before invoking npm at all, keeping the checkout untouched.
    await cp(directory, stage, { recursive: true, filter: source => {
      const parts = relative(directory, source).split(sep);
      return !parts.includes('node_modules') && !parts.includes('.git') && resolve(source) !== resolve(out) && resolve(source) !== resolve(stage);
    } });
    await writeFile(join(stage, 'package.json'), publishedManifest(await readFile(join(directory, 'package.json'), 'utf8')));
    for (const [path, text] of Object.entries(replace)) { await mkdir(dirname(join(stage, path)), { recursive: true }); await writeFile(join(stage, path), text); }
    const [packed] = parsePackJson<{ filename: string }>(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', out], stage));
    return join(out, packed!.filename);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/** Packs core (in `directory`) into `out` with `manifest` as its dist/addons.json and its published package.json. Returns the tarball path. */
export async function packWithManifest(directory: string, out: string, manifest: string): Promise<string> {
  const problems = shippedManifestProblems(manifest);
  if (problems.length) throw new Error(`Refusing to pack core with an unpinned add-on manifest:\n- ${problems.join('\n- ')}`);
  const file = await packPublished(directory, out, { 'dist/addons.json': manifest });
  if (shippedManifest(file) !== manifest) throw new Error(`${file} does not carry the add-on manifest it was packed with`);
  return file;
}

/**
 * `urlBase` (for example https://github.com/jimhoyd-com/urlcode/releases/download/v1.2.3) replaces the local `file:`
 * tarball URLs. Either way the packed core carries this manifest, the pins of exactly these add-on bytes, as a release
 * does; the checkout's own development dist/addons.json is left as it is.
 */
export async function packAddons(out: string, { urlBase }: { urlBase?: string } = {}): Promise<PackedAddons> {
  const all = await addons();
  await assertBuilt([{ packageName: '@jimhoyd/urlcode', directory: repositoryRoot, build: 'npm run build' }, ...all.map(addon => ({ packageName: addon.packageName, directory: addon.directory, build: 'node scripts/workspaces.ts run build' }))]);
  await mkdir(out, { recursive: true });
  const version = (JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const tarballs: Record<string, string> = {}, entries: Record<string, unknown> = {};
  for (const addon of all) {
    if (addon.version !== version) throw new Error(`${addon.packageName} is ${addon.version}; every add-on must share core's version ${version}`);
    // An add-on packs through its published manifest too: its `development` conditions name src/, which never ships.
    const file = tarballs[addon.name] = await packPublished(addon.directory, out);
    const name = file.slice(out.length + 1);
    entries[addon.name] = { kind: addon.kind, package: addon.packageName, description: addon.description, requires: addon.requires, ...(addon.uses.length ? { uses: addon.uses } : {}), url: urlBase ? `${urlBase}/${name}` : `file:${file}`, integrity: integrity(await readFile(file)) };
  }
  const manifest = join(out, 'addons.json');
  const text = JSON.stringify({ format: 1, version, addons: entries }, null, 2) + '\n';
  await writeFile(manifest, text);
  // Core's published manifest drops its development-only `prepare` build hook and `development` export conditions.
  return { core: await packWithManifest(repositoryRoot, out, text), tarballs, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), option = (name: string): string | undefined => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const out = resolve(args[0] ?? 'packed'), site = option('--site');
  // The packed core pins these tarballs, exactly as a released core pins its release's add-ons.
  const packed = await packAddons(out);
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
