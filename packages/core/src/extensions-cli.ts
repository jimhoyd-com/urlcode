import { addAddons, listAddons, removeAddon } from './addon-install.ts';
import { readAddonManifest } from './addon-manifest.ts';
import type { AddonKind } from './addon-manifest.ts';
import { inspectInstalledArtifact } from './artifact-inspect.ts';
import type { ArtifactInspection, InspectedFile } from './artifact-inspect.ts';
import { ConfigError } from './errors.ts';

type Print = (value: unknown) => boolean;
interface AddonCliOptions { site?: string | undefined; json?: boolean | undefined; strict?: boolean | undefined; ack?: string[] | undefined; example?: boolean | undefined }

export const addonCommands = ['available', 'add', 'remove', 'list', 'inspect'] as const;

/**
 * `urlcode extensions|artifacts available|add|remove|list`: the same verbs for both add-on kinds, plus `artifacts
 * inspect`. Returns the process exit code for `list --strict` with problems or `inspect --strict` with an error
 * diagnostic; everything else prints and returns undefined.
 */
export async function runAddonCommand(command: 'extensions' | 'artifacts', operation: string, names: string[], values: AddonCliOptions, print: Print): Promise<number | undefined> {
  const kind: AddonKind = command === 'extensions' ? 'extension' : 'artifact';
  const site = values.site ?? '.';
  if (values.ack?.length && operation !== 'add') throw new ConfigError(`--ack is only supported by ${command} add`);
  if (values.example && (operation !== 'add' || kind !== 'extension')) throw new ConfigError('--example is only supported by extensions add');
  if (values.strict && operation !== 'list' && !(operation === 'inspect' && kind === 'artifact')) throw new ConfigError(`--strict is only supported by ${command} list${kind === 'artifact' ? ' and inspect' : ''}`);
  switch (operation) {
    case 'available': {
      if (names.length) throw new ConfigError(`Use urlcode ${command} available`);
      const manifest = await readAddonManifest();
      const items = Object.entries(manifest.addons).filter(([, pin]) => pin.kind === kind).map(([name, pin]) => ({ name, version: manifest.version, description: pin.description, requires: pin.requires, uses: pin.uses ?? [] }));
      const edges = (item: { requires: string[]; uses: string[] }): string => { const parts = [...(item.requires.length ? [`requires ${item.requires.join(', ')}`] : []), ...(item.uses.length ? [`uses ${item.uses.join(', ')}`] : [])]; return parts.length ? ` (${parts.join('; ')})` : ''; };
      print(values.json ? { core: manifest.version, [command]: items } : `${command === 'extensions' ? 'Extensions' : 'Artifacts'} released with core ${manifest.version}:\n${items.map(item => `  ${item.name}${edges(item)}: ${item.description}`).join('\n') || '  none'}\n\nAdd with: urlcode ${command} add <name>\n`);
      return undefined;
    }
    case 'add': {
      if (!names.length) throw new ConfigError(`Use urlcode ${command} add <name> [<name>…] (a released name, or an npm package spec or local tarball of an independent ${kind})${kind === 'extension' ? ' [--example] [--ack <extension>:<id>]' : ''} [--site directory]`);
      const result = await addAddons(site, kind, names, { acknowledgements: values.ack, example: values.example });
      print(values.json ? { event: `${kind}s-added`, ...result } : [
        result.added.length ? `Added ${result.added.join(', ')}${result.development ? ' (development install from local sources, not pinned)' : ''}.` : `${names.join(', ')} already installed; nothing to do.`,
        ...(result.examples.length ? [`Example written for ${result.examples.join(', ')} (--example).`] : kind === 'extension' && result.added.length ? ['Capability only: no sample routes were written. Add --example to a fresh add for a working demo.'] : []),
        ...result.keptFiles.map(file => `Kept existing ${file}.`),
        ...Object.entries(result.env).map(([key, text]) => `Environment: ${key}: ${text}`),
        ...result.notes.map(note => `Next: ${note}`),
        ...(result.projectSha256 ? [`Project revision: ${result.projectSha256}. Review the project, then pin the host to exactly this value: the projectSha256 of the reviewed policy passed with --policy, or PROJECT_SHA256 where the host runs.`] : []),
      ].join('\n') + '\n');
      return undefined;
    }
    case 'remove': {
      if (names.length !== 1) throw new ConfigError(`Use urlcode ${command} remove <name> [--site directory]`);
      const result = await removeAddon(site, kind, names[0]!);
      print(values.json ? { event: `${kind}-removed`, ...result } : [
        `Removed ${result.removed}.`,
        ...result.notes.map(note => `Note: ${note}`),
        ...(result.kept.length ? [`Left in place (delete them yourself if you no longer need them): ${result.kept.join(', ')}; data/ is never touched.`] : []),
        ...(result.projectSha256 ? [`Project revision: ${result.projectSha256}. Update the reviewed policy's projectSha256 (or PROJECT_SHA256) after reviewing.`] : []),
      ].join('\n') + '\n');
      return undefined;
    }
    case 'list': {
      if (names.length) throw new ConfigError(`Use urlcode ${command} list [--strict] [--json] [--site directory]`);
      const report = await listAddons(site, kind);
      if (values.json) print(report);
      else print([
        `${command === 'extensions' ? 'Extensions' : 'Artifacts'} in ${report.site} (core ${report.core}${report.development ? ', development manifest' : ''}):`,
        ...(report.addons.length ? report.addons.map(item => `  ${item.name} ${item.version ?? '(not installed)'} ${item.independent ? `${item.package}, independent, ${item.pinned ? 'locked by npm integrity' : 'linked, not locked'}` : item.pinned ? 'pinned' : 'NOT PINNED'}${item.mode === 'library' ? ' (library: not declared or imported as an extension)' : ''}${item.problems.length ? ` — ${item.problems.length} problem(s)` : ''}`) : ['  none']),
        ...report.unmanaged.map(name => `  ${name}: not released with this core (unmanaged)`),
        ...report.problems.map(problem => `Problem: ${problem}`),
      ].join('\n') + '\n');
      return values.strict && report.problems.length ? 1 : undefined;
    }
    case 'inspect': {
      if (kind !== 'artifact') throw new ConfigError('inspect is only supported by artifacts: urlcode artifacts inspect <name>');
      if (names.length !== 1) throw new ConfigError('Use urlcode artifacts inspect <name> [--strict] [--json] [--site directory]');
      const inspection = await inspectInstalledArtifact(site, names[0]!);
      print(values.json ? inspection : renderInspection(inspection));
      const failed = [...inspection.documents, ...inspection.referencedFiles].some(file => file.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
      return values.strict && failed ? 1 : undefined;
    }
    default: throw new ConfigError(`Unknown ${command} command ${operation}; use ${(kind === 'artifact' ? addonCommands : addonCommands.filter(item => item !== 'inspect')).join(', ')}`);
  }
}

const verified: Record<ArtifactInspection['artifact']['verification'], string> = {
  'catalog-pin': 'pinned by this core',
  development: 'development link, not pinned',
  'local-tarball': 'npm lock integrity, re-checked against its local tarball',
  'lock-integrity': 'npm lock integrity (not re-checked offline)',
};
/** Text form of an inspection. Every package-supplied string is JSON-quoted, so it cannot pass for this output's own text. */
function renderInspection(inspection: ArtifactInspection): string {
  const { artifact } = inspection;
  const file = (item: InspectedFile): string[] => [
    `  ${item.path}${item.mediaType ? ` (${item.mediaType})` : ''}: ${item.kind ?? 'unread'}${item.version === null ? '' : ` ${JSON.stringify(item.version)}`}, ${item.bytes ?? '?'} bytes${item.sha256 ? `, sha256 ${item.sha256}` : ''}`,
    ...item.refs.map(ref => `    ref ${ref.at || '/'} ${JSON.stringify(ref.ref)} -> ${ref.target}`),
    ...item.diagnostics.map(diagnostic => `    ${diagnostic.severity} ${diagnostic.code}${diagnostic.at === undefined ? '' : ` at ${diagnostic.at || '/'}`}${diagnostic.ref === undefined ? '' : ` ${JSON.stringify(diagnostic.ref)}`}: ${diagnostic.message}`),
  ];
  return [
    `Artifact ${artifact.name}: ${artifact.package} ${artifact.version ?? '(unknown version)'}${artifact.independent ? ', independent' : ''}; ${verified[artifact.verification]}${artifact.integrity ? ` (${artifact.integrity})` : ''}`,
    inspection.notice,
    'Documents:',
    ...(inspection.documents.length ? inspection.documents.flatMap(file) : ['  none listed in its urlcode.json']),
    ...(inspection.referencedFiles.length ? ['Referenced files:', ...inspection.referencedFiles.flatMap(file)] : []),
  ].join('\n') + '\n';
}
