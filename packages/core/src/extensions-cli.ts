import { addAddons, listAddons, removeAddon } from './addon-install.ts';
import { readAddonManifest } from './addon-manifest.ts';
import type { AddonKind } from './addon-manifest.ts';
import { ConfigError } from './errors.ts';

type Print = (value: unknown) => boolean;
interface AddonCliOptions { site?: string | undefined; json?: boolean | undefined; strict?: boolean | undefined; ack?: string[] | undefined; example?: boolean | undefined }

export const addonCommands = ['available', 'add', 'remove', 'list'] as const;

/**
 * `urlcode extensions|artifacts available|add|remove|list`: the same verbs for both add-on kinds. Returns the
 * process exit code for `list --strict` with problems; everything else prints and returns undefined.
 */
export async function runAddonCommand(command: 'extensions' | 'artifacts', operation: string, names: string[], values: AddonCliOptions, print: Print): Promise<number | undefined> {
  const kind: AddonKind = command === 'extensions' ? 'extension' : 'artifact';
  const site = values.site ?? '.';
  if (values.ack?.length && operation !== 'add') throw new ConfigError(`--ack is only supported by ${command} add`);
  if (values.example && (operation !== 'add' || kind !== 'extension')) throw new ConfigError('--example is only supported by extensions add');
  if (values.strict && operation !== 'list') throw new ConfigError(`--strict is only supported by ${command} list`);
  switch (operation) {
    case 'available': {
      if (names.length) throw new ConfigError(`Use urlcode ${command} available`);
      const manifest = await readAddonManifest();
      const items = Object.entries(manifest.addons).filter(([, pin]) => pin.kind === kind).map(([name, pin]) => ({ name, version: manifest.version, description: pin.description, requires: pin.requires }));
      print(values.json ? { core: manifest.version, [command]: items } : `${command === 'extensions' ? 'Extensions' : 'Artifacts'} released with core ${manifest.version}:\n${items.map(item => `  ${item.name}${item.requires.length ? ` (requires ${item.requires.join(', ')})` : ''}: ${item.description}`).join('\n') || '  none'}\n\nAdd with: urlcode ${command} add <name>\n`);
      return undefined;
    }
    case 'add': {
      if (!names.length) throw new ConfigError(`Use urlcode ${command} add <name> [<name>…]${kind === 'extension' ? ' [--example] [--ack <extension>:<id>]' : ''} [--site directory]`);
      const result = await addAddons(site, kind, names, { acknowledgements: values.ack, example: values.example });
      print(values.json ? { event: `${kind}s-added`, ...result } : [
        result.added.length ? `Added ${result.added.join(', ')}${result.development ? ' (development install from local sources, not pinned)' : ''}.` : `${names.join(', ')} already installed; nothing to do.`,
        ...(result.examples.length ? [`Example written for ${result.examples.join(', ')} (--example).`] : kind === 'extension' && result.added.length ? ['Capability only: no sample routes were written. Add --example to a fresh add for a working demo.'] : []),
        ...result.keptFiles.map(file => `Kept existing ${file}.`),
        ...Object.entries(result.env).map(([key, text]) => `Environment: ${key}: ${text}`),
        ...result.notes.map(note => `Next: ${note}`),
        ...(result.projectSha256 ? [`Project revision: ${result.projectSha256}. Review the project, then set PROJECT_SHA256 to exactly this value where the host runs.`] : []),
      ].join('\n') + '\n');
      return undefined;
    }
    case 'remove': {
      if (names.length !== 1) throw new ConfigError(`Use urlcode ${command} remove <name> [--site directory]`);
      const result = await removeAddon(site, kind, names[0]!);
      print(values.json ? { event: `${kind}-removed`, ...result } : [
        `Removed ${result.removed}.`,
        ...(result.kept.length ? [`Left in place (delete them yourself if you no longer need them): ${result.kept.join(', ')}; data/ is never touched.`] : []),
        ...(result.projectSha256 ? [`Project revision: ${result.projectSha256}. Update PROJECT_SHA256 after reviewing.`] : []),
      ].join('\n') + '\n');
      return undefined;
    }
    case 'list': {
      if (names.length) throw new ConfigError(`Use urlcode ${command} list [--strict] [--json] [--site directory]`);
      const report = await listAddons(site, kind);
      if (values.json) print(report);
      else print([
        `${command === 'extensions' ? 'Extensions' : 'Artifacts'} in ${report.site} (core ${report.core}${report.development ? ', development manifest' : ''}):`,
        ...(report.addons.length ? report.addons.map(item => `  ${item.name} ${item.version ?? '(not installed)'} ${item.pinned ? 'pinned' : 'NOT PINNED'}${item.mode === 'library' ? ' (library: not declared or imported as an extension)' : ''}${item.problems.length ? ` — ${item.problems.length} problem(s)` : ''}`) : ['  none']),
        ...report.unmanaged.map(name => `  ${name}: not released with this core (unmanaged)`),
        ...report.problems.map(problem => `Problem: ${problem}`),
      ].join('\n') + '\n');
      return values.strict && report.problems.length ? 1 : undefined;
    }
    default: throw new ConfigError(`Unknown ${command} command ${operation}; use ${addonCommands.join(', ')}`);
  }
}
