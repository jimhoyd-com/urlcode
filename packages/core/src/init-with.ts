import { addAddons } from './addon-install.ts';
import type { AddResult } from './addon-install.ts';
import type { AddonManifest } from './addon-manifest.ts';
import { initSite } from './authoring.ts';
import { assert } from './errors.ts';

const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
export function parseWithNames(value: string): string[] {
  const names = value.split(',').map(name => name.trim());
  assert(names.length > 0 && names.every(name => namePattern.test(name)), 'Use --with name[,name] where each name is an extension such as auth; `urlcode extensions available` lists them');
  assert(new Set(names).size === names.length, 'Duplicate --with names');
  return names;
}

/**
 * `urlcode init <directory> --with a,b [--example]`: the site layout, then `urlcode extensions add a b` in it. A refusal at
 * any step undoes the whole init, so nothing is left behind.
 */
export async function initSiteWith(destination: string, names: readonly string[], { acknowledgements = [], example = false, manifest }: { acknowledgements?: readonly string[]; example?: boolean; manifest?: AddonManifest } = {}): Promise<AddResult & { site: string }> {
  assert(names.length > 0, 'Provide at least one --with name');
  const { site, undo } = await initSite(destination);
  const quote = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
  try {
    const result = await addAddons(site, 'extension', names, { acknowledgements, example, manifest, retry: acks => ['urlcode init', quote(destination), '--with', names.join(','), ...(example ? ['--example'] : []), ...acks.flatMap(ack => ['--ack', ack])].join(' ') });
    return { site, ...result };
  } catch (error) { await undo(); throw error; }
}
