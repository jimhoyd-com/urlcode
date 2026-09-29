import { addAddons } from './addon-install.ts';
import type { AddResult } from './addon-install.ts';
import type { AddonManifest } from './addon-manifest.ts';
import { initSite } from './authoring.ts';
import { ConfigError, assert } from './errors.ts';

const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
export function parseWithNames(value: string): string[] {
  const names = value.split(',').map(name => name.trim());
  assert(names.length > 0 && names.every(name => namePattern.test(name)), 'Use --with name[,name] where each name is an extension such as auth; `urlcode extensions available` lists them');
  assert(new Set(names).size === names.length, 'Duplicate --with names');
  return names;
}

/**
 * `urlcode init <directory> --with a,b [--example] [--adopt]`: the site layout, then `urlcode extensions add a b` in it. A refusal at
 * any step undoes the whole init, so nothing is left behind.
 */
export async function initSiteWith(destination: string, names: readonly string[], { acknowledgements = [], example = false, adopt = false, mcp, manifest }: { acknowledgements?: readonly string[]; example?: boolean; adopt?: boolean; mcp?: boolean | undefined; manifest?: AddonManifest } = {}): Promise<AddResult & { site: string; leftAlone: string[] }> {
  assert(names.length > 0, 'Provide at least one --with name');
  // Adopting, npm's node_modules and package-lock.json are checked with init's own files before anything is written;
  // an add-on's scaffold files are known only once it is installed, and one under an adopted entry undoes the init.
  const { site, undo, leftAlone } = await initSite(destination, { adopt, installs: true, mcp });
  const quote = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
  try {
    const result = await addAddons(site, 'extension', names, { acknowledgements, example, manifest, retry: acks => ['urlcode init', quote(destination), '--with', names.join(','), ...(example ? ['--example'] : []), ...(adopt ? ['--adopt'] : []), ...(mcp === false ? ['--no-mcp'] : []), ...acks.flatMap(ack => ['--ack', ack])].join(' '), ...(adopt ? { preserve: leftAlone } : {}) });
    return { site, leftAlone, ...result };
  } catch (error) {
    await undo();
    // The import of an installed add-on failed (#911): name the undone init and the two-step path that keeps the site.
    if (error instanceof ConfigError && error.details.code === 'addon-load') throw new ConfigError(`${error.message}. init --with removed everything it created; to keep the site while you fix this, run \`urlcode init ${quote(destination)}\`, then \`urlcode extensions add ${names.join(' ')}\` in it`, error.details, { cause: error });
    throw error;
  }
}
