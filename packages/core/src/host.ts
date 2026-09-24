import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, assert } from './errors.ts';
import type { ExtensionEntry, HostContext, HostedExtension } from './extensions.ts';
import type { OperatorHost } from './operator-host.ts';
import type { RuntimeOptions } from './runtime.ts';

/**
 * Orders items so every item follows the ones it `requires`: Kahn's algorithm, lexically smallest ready name
 * first, so every permutation of the same set gives the same order. A requirement outside the set or a cycle
 * refuses by name.
 */
export function orderByRequires<T extends { name: string; requires?: readonly string[] | undefined }>(items: readonly T[], missing: (item: T, requirement: string) => string): T[] {
  const byName = new Map(items.map(item => [item.name, item]));
  assert(byName.size === items.length, 'Duplicate extension names');
  for (const item of items) for (const requirement of item.requires ?? []) if (!byName.has(requirement)) throw new ConfigError(missing(item, requirement));
  const ordered: T[] = [], placed = new Set<string>();
  while (ordered.length < items.length) {
    const ready = [...byName.keys()].filter(name => !placed.has(name) && (byName.get(name)!.requires ?? []).every(requirement => placed.has(requirement))).sort();
    if (!ready.length) {
      const stuck = [...byName.keys()].filter(name => !placed.has(name)).sort();
      throw new ConfigError(`Extension requirements form a cycle among ${stuck.join(', ')}`);
    }
    placed.add(ready[0]!); ordered.push(byName.get(ready[0]!)!);
  }
  return ordered;
}

interface ComposeOptions { plugins?: RuntimeOptions['plugins'] }

/**
 * Builds the operator host from host.mjs's list of extensions:
 *
 *   export default await composeHost(import.meta.url, [ui(), auth(), admin()]);
 *
 * It reads the reviewed `PROJECT_SHA256` once, orders the extensions by `requires`, activates each `host()` once
 * (dependants receive the shared instance through `get`, and contributions through `contributions`), and returns
 * the `{extensions, plugins, close}` object `--host-file` loads. `close` releases in reverse order. Core never
 * imports an extension: host.mjs does, and passes the definitions in.
 */
export async function composeHost(hostUrl: string | URL, entries: readonly ExtensionEntry[], { plugins }: ComposeOptions = {}): Promise<OperatorHost> {
  const site = dirname(fileURLToPath(hostUrl));
  assert(Array.isArray(entries) && entries.every(entry => entry && typeof entry === 'object' && typeof entry.definition?.host === 'function'), 'composeHost takes the extension list from host.mjs, for example [ui(), auth()]');
  // A site with no extensions has nothing to pin.
  if (!entries.length) return { extensions: [], ...(plugins ? { plugins } : {}) };
  const projectSha256 = process.env.PROJECT_SHA256 ?? '';
  if (!/^[a-f0-9]{64}$/.test(projectSha256)) throw new ConfigError('Set PROJECT_SHA256 to the reviewed project revision (urlcode extensions add prints it; urlcode explain shows it)');
  const definitions = entries.map(entry => entry.definition);
  const ordered = orderByRequires(definitions.map((definition, index) => ({ name: definition.name, requires: definition.requires, index })),
    (item, requirement) => `${item.name} requires ${requirement}; add it with \`urlcode extensions add ${requirement}\``);
  const contributions = new Map<string, unknown[]>();
  for (const definition of definitions) for (const [target, value] of Object.entries(definition.contributes ?? {})) {
    if (!contributions.has(target)) contributions.set(target, []);
    contributions.get(target)!.push(value);
  }
  const hosted: { name: string; result: HostedExtension }[] = [];
  const exported = new Map<string, unknown>();
  const close = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const { result } of [...hosted].reverse()) { try { await result.close?.(); } catch (error) { errors.push(error); } }
    hosted.length = 0;
    if (errors.length) throw new AggregateError(errors, 'Closing the operator host failed');
  };
  try {
    for (const { name, index } of ordered) {
      const definition = definitions[index]!;
      const allowed = new Set(definition.requires ?? []);
      const context: HostContext = {
        projectSha256, site,
        get: <T>(other: string): T => {
          assert(allowed.has(other), `${name} reads ${other} from the host but does not declare it in requires`);
          return exported.get(other) as T;
        },
        contributions: <T>(target: string): T[] => [...(contributions.get(target) ?? [])] as T[],
      };
      const result = await definition.host(context, entries[index]!.options);
      assert(result && typeof result === 'object' && result.registration?.name === name, `${name} host() must return {registration} for extension ${name}`);
      assert(result.registration.projectSha256 === projectSha256, `${name} host() must register the reviewed PROJECT_SHA256`);
      assert(JSON.stringify(result.registration.schema) === JSON.stringify(definition.schema), `${name} registers a configuration schema that differs from its definition`);
      hosted.push({ name, result });
      exported.set(name, result.exports);
    }
  } catch (error) { await close().catch(() => undefined); throw error; }
  return { extensions: hosted.map(({ result }) => result.registration), ...(plugins ? { plugins } : {}), close };
}
