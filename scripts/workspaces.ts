// The one list of add-ons (extensions under packages/, artifacts under artifacts/), read from each workspace's
// urlcode.json and ordered so every add-on follows the ones it requires, and the ones it uses or contributes to (optional
// edges: its tests may compose with them, so a present one is built first). Scripts, CI and the release all use this
// instead of keeping their own list of names.
//
//   node scripts/workspaces.ts list          JSON array of add-ons in dependency order
//   node scripts/workspaces.ts run <script>  npm run <script> in every add-on that defines it, in dependency order
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface Addon { name: string; kind: 'extension' | 'artifact'; directory: string; packageName: string; version: string; description: string; requires: string[]; uses: string[]; contributes: string[]; scripts: Record<string, string> }
export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function addons(root = repositoryRoot): Promise<Addon[]> {
  const found: Addon[] = [];
  for (const parent of ['packages', 'artifacts']) {
    const names = await readdir(join(root, parent), { withFileTypes: true }).then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name), () => [] as string[]);
    for (const name of names.sort()) {
      const directory = join(root, parent, name);
      let descriptor: { kind?: unknown; name?: unknown; description?: unknown; requires?: unknown; uses?: unknown; contributes?: unknown };
      try { descriptor = JSON.parse(await readFile(join(directory, 'urlcode.json'), 'utf8')); } catch { continue; }
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string; version: string; scripts?: Record<string, string> };
      const kind = parent === 'packages' ? 'extension' : 'artifact';
      if (descriptor.kind !== kind || descriptor.name !== name || pkg.name !== `@jimhoyd/urlcode-${name}`) throw new Error(`${parent}/${name}: urlcode.json and package.json must describe ${kind} ${name} as @jimhoyd/urlcode-${name}`);
      found.push({ name, kind, directory, packageName: pkg.name, version: pkg.version, description: String(descriptor.description ?? ''), requires: Array.isArray(descriptor.requires) ? descriptor.requires.map(String) : [], uses: Array.isArray(descriptor.uses) ? descriptor.uses.map(String) : [], contributes: Array.isArray(descriptor.contributes) ? descriptor.contributes.map(String) : [], scripts: pkg.scripts ?? {} });
    }
  }
  const byName = new Map(found.map(addon => [addon.name, addon]));
  const ordered: Addon[] = [], placed = new Set<string>();
  while (ordered.length < found.length) {
    const ready = found.filter(addon => !placed.has(addon.name) && addon.requires.every(requirement => { if (!byName.has(requirement)) throw new Error(`${addon.name} requires unknown add-on ${requirement}`); return placed.has(requirement); })
      && [...addon.uses, ...addon.contributes].every(target => !byName.has(target) || placed.has(target)));
    if (!ready.length) throw new Error(`Add-on requirements form a cycle among ${found.filter(addon => !placed.has(addon.name)).map(addon => addon.name).join(', ')}`);
    for (const addon of ready) { placed.add(addon.name); ordered.push(addon); }
  }
  return ordered;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, script] = process.argv.slice(2);
  const list = await addons();
  if (command === 'list') process.stdout.write(JSON.stringify(list.map(({ scripts: _scripts, ...addon }) => addon), null, 2) + '\n');
  else if (command === 'run' && script) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    for (const addon of list) {
      if (!addon.scripts[script]) continue;
      const result = spawnSync(npm, ['run', script, '--workspace', addon.packageName], { stdio: 'inherit', shell: process.platform === 'win32' });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  } else { process.stderr.write('Use: node scripts/workspaces.ts list | run <script>\n'); process.exit(2); }
}
