// Keeps every add-on's static descriptor true to its code, and writes core's add-on manifest.
//
//   node scripts/build-addon-manifest.ts           rewrite extension urlcode.json files (from each built
//                                                  ./extension definition) and generated artifact data
//   node scripts/build-addon-manifest.ts --check   fail if any committed file differs from what the code says
//
// `developmentManifest()` is the dist/addons.json that `npm run build` writes: every add-on at its local source
// (`file:` directory, no integrity), so `urlcode extensions add` works from a checkout. The release build
// (scripts/release-pack.ts) replaces it with release URLs and sha512 pins before core is packed.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addons, repositoryRoot } from './workspaces.ts';

const render = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
/** Artifact files generated from an extension's descriptor, so the two can never disagree. */
const generated: Record<string, Record<string, { from: string; field: 'schema' | 'policySchema' }>> = {
  'store-schema': { 'schemas/config.json': { from: 'store', field: 'schema' } },
};

export async function expectedFiles(root = repositoryRoot): Promise<Map<string, string>> {
  const files = new Map<string, string>(), descriptors = new Map<string, Record<string, unknown>>();
  for (const addon of await addons(root)) {
    if (addon.kind !== 'extension') continue;
    const module = await import(pathToFileURL(join(addon.directory, 'dist', 'extension.js')).href) as { default?: { definition?: Record<string, unknown> } };
    const definition = module.default?.definition;
    if (!definition || definition.name !== addon.name) throw new Error(`${addon.packageName}/extension must default-export defineExtension({name: '${addon.name}'})`);
    const descriptor = { kind: 'extension', name: definition.name, description: definition.description, requires: definition.requires ?? [],
      schema: definition.schema, ...(definition.policySchema ? { policySchema: definition.policySchema } : {}), ...(definition.hooks ? { hooks: definition.hooks } : {}), ...(definition.authoring ? { authoring: definition.authoring } : {}) };
    descriptors.set(addon.name, descriptor);
    files.set(join(addon.directory, 'urlcode.json'), render(descriptor));
  }
  for (const addon of await addons(root)) for (const [path, source] of Object.entries(generated[addon.name] ?? {})) {
    const value = descriptors.get(source.from)?.[source.field];
    if (!value) throw new Error(`${addon.name}/${path} is generated from ${source.from}'s ${source.field}, which is missing`);
    files.set(join(addon.directory, path), render(value));
  }
  return files;
}

export async function developmentManifest(root = repositoryRoot): Promise<string> {
  const version = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const entries = (await addons(root)).map(addon => [addon.name, { kind: addon.kind, package: addon.packageName, description: addon.description, requires: addon.requires, url: `file:${addon.directory}`, integrity: null }]);
  return render({ format: 1, version, addons: Object.fromEntries(entries) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check'), stale: string[] = [];
  for (const [path, content] of await expectedFiles()) {
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current === content) continue;
    if (check) stale.push(path); else await writeFile(path, content);
  }
  if (stale.length) { process.stderr.write(`Out of date (run npm run build:addons):\n${stale.map(path => `  ${path}`).join('\n')}\n`); process.exit(1); }
}
