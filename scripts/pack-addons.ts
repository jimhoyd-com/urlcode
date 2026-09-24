// Packs core and every add-on with npm pack, and writes the addons.json that pins each add-on tarball by sha512.
// The integration test and CI pin `file:` tarballs; the release passes the GitHub Release download base instead.
//
//   node scripts/pack-addons.ts <out-directory> [--site <directory> --with a,b [--ack x:y]]
//
// With --site it also creates a site from the packed runtime and adds the named extensions to it (the CI action job).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addons, repositoryRoot } from './workspaces.ts';
import { npmCommand } from './npm-command.ts';

export interface PackedAddons { core: string; tarballs: Record<string, string>; manifest: string }
const npm = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string => { const command = npmCommand(args); return execFileSync(command.command, command.args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); };
export const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** `urlBase` (for example https://github.com/jimhoyd-com/urlcode/releases/download/v1.2.3) replaces the local `file:` URLs. */
export async function packAddons(out: string, { urlBase }: { urlBase?: string } = {}): Promise<PackedAddons> {
  await mkdir(out, { recursive: true });
  const pack = (dir: string): string => join(out, (JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', out], dir)) as { filename: string }[])[0]!.filename);
  const version = (JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const tarballs: Record<string, string> = {}, entries: Record<string, unknown> = {};
  for (const addon of await addons()) {
    if (addon.version !== version) throw new Error(`${addon.packageName} is ${addon.version}; every add-on must share core's version ${version}`);
    const file = tarballs[addon.name] = pack(addon.directory);
    const name = file.slice(out.length + 1);
    entries[addon.name] = { kind: addon.kind, package: addon.packageName, description: addon.description, requires: addon.requires, url: urlBase ? `${urlBase}/${name}` : `file:${file}`, integrity: integrity(await readFile(file)) };
  }
  const manifest = join(out, 'addons.json');
  await writeFile(manifest, JSON.stringify({ format: 1, version, addons: entries }, null, 2) + '\n');
  return { core: pack(repositoryRoot), tarballs, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), option = (name: string): string | undefined => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const out = resolve(args[0] ?? 'packed'), site = option('--site');
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
    if (names.length) run(['extensions', 'add', ...names, ...(ack ? ['--ack', ack] : [])], resolve(site));
    else npm(['install', '--ignore-scripts'], resolve(site), env);
  }
}
