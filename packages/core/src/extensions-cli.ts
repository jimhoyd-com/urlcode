import { addAddons, listAddons, outdatedAddons, removeAddon, verifyAddons } from './addon-install.ts';
import type { OutdatedReport, VerifyReport } from './addon-install.ts';
import { readAddonManifest } from './addon-manifest.ts';
import type { AddonKind } from './addon-manifest.ts';
import { inspectInstalledArtifact } from './artifact-inspect.ts';
import type { ArtifactInspection, InspectedFile } from './artifact-inspect.ts';
import { ConfigError } from './errors.ts';
import { describeDrift } from './package-files.ts';
import { materializeSourceAssets, stageSourceAssets } from './source-stage.ts';
import type { MaterializeResult, SourceStageReport } from './source-stage.ts';

type Print = (value: unknown) => boolean;
interface AddonCliOptions { site?: string | undefined; json?: boolean | undefined; strict?: boolean | undefined; ack?: string[] | undefined; example?: boolean | undefined; materialize?: boolean | undefined; into?: string | undefined; 'allow-app'?: boolean | undefined }

export const addonCommands = ['available', 'add', 'remove', 'list', 'verify', 'outdated', 'inspect', 'stage'] as const;
const artifactOnly = new Set<string>(['inspect', 'stage']);

/**
 * `urlcode extensions|artifacts available|add|remove|list|verify|outdated`: the same verbs for both add-on kinds, plus
 * `artifacts inspect` and `stage`. Returns the process exit code for `list --strict` with problems, `verify` with
 * problems or `inspect --strict` with an error diagnostic; everything else prints and returns undefined.
 */
export async function runAddonCommand(command: 'extensions' | 'artifacts', operation: string, names: string[], values: AddonCliOptions, print: Print): Promise<number | undefined> {
  const kind: AddonKind = command === 'extensions' ? 'extension' : 'artifact';
  const site = values.site ?? '.';
  if (values.ack?.length && operation !== 'add') throw new ConfigError(`--ack is only supported by ${command} add`);
  if (values.example && (operation !== 'add' || kind !== 'extension')) throw new ConfigError('--example is only supported by extensions add');
  if ((values.materialize || values.into !== undefined || values['allow-app']) && !(operation === 'stage' && kind === 'artifact')) throw new ConfigError('--materialize, --into and --allow-app are only supported by artifacts stage');
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
        ...(result.added.length ? [`Added ${result.added.join(', ')}${result.development ? ' (development install from local sources, not pinned)' : ''}.`] : []),
        ...result.upgraded.map(item => `Upgraded ${item.name} (${item.package}) from ${item.from ?? '?'} to ${item.to ?? '?'}; its declaration, routes and host.mjs line are unchanged. Review the new version before deploying it.`),
        ...(result.added.length || result.upgraded.length ? [] : [`${names.join(', ')} already installed; nothing to do.`]),
        ...(result.examples.length ? [`Example written for ${result.examples.join(', ')} (--example).`] : kind === 'extension' && result.added.length ? ['Capability only: no sample routes were written. Add --example to a fresh add for a working demo.'] : []),
        ...result.keptFiles.map(file => `Kept existing ${file}.`),
        ...Object.entries(result.env).map(([key, text]) => `Environment: ${key}: ${text}`),
        ...result.notes.map(note => `Next: ${note}`),
        ...(result.projectSha256 ? [`Project revision: ${result.projectSha256}. Review the project, then pin the host to exactly this value: the projectSha256 of the reviewed policy passed with --policy, or PROJECT_SHA256 where the host runs. npm run validate, test, routes and audit review every edit locally without a pin (--local-review); npm run dev and npm start read the origin and policy from URLCODE_ORIGIN and URLCODE_POLICY.`] : []),
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
    case 'verify': {
      if (names.length > 1) throw new ConfigError(`Use urlcode ${command} verify [<name>] [--json] [--site directory]`);
      const report = await verifyAddons(site, kind, names[0]);
      print(values.json ? report : renderVerify(command, report));
      return report.problems.length ? 1 : undefined;
    }
    case 'outdated': {
      if (names.length) throw new ConfigError(`Use urlcode ${command} outdated [--json] [--site directory]`);
      const report = await outdatedAddons(site, kind);
      print(values.json ? report : renderOutdated(command, report));
      return undefined;
    }
    case 'inspect': {
      if (kind !== 'artifact') throw new ConfigError('inspect is only supported by artifacts: urlcode artifacts inspect <name>');
      if (names.length !== 1) throw new ConfigError('Use urlcode artifacts inspect <name> [--strict] [--json] [--site directory]');
      const inspection = await inspectInstalledArtifact(site, names[0]!);
      print(values.json ? inspection : renderInspection(inspection));
      const failed = [...inspection.documents, ...inspection.referencedFiles].some(file => file.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
      return values.strict && failed ? 1 : undefined;
    }
    case 'stage': {
      if (kind !== 'artifact') throw new ConfigError('stage is only supported by artifacts: urlcode artifacts stage <source>');
      if (names.length !== 1) throw new ConfigError('Use urlcode artifacts stage <registry-item.json|source directory> [--into directory] [--json] [--site directory], then add --materialize --into <directory> [--allow-app] to write the staged files');
      if (values['allow-app'] && !values.materialize) throw new ConfigError('--allow-app is only supported with --materialize');
      if (values.materialize) {
        if (values.into === undefined) throw new ConfigError('--materialize needs --into <directory>: the directory the staged files are written under');
        const result = await materializeSourceAssets(names[0]!, { into: values.into, site, allowApp: values['allow-app'] });
        print(values.json ? result : renderMaterialized(result));
        return undefined;
      }
      const report = await stageSourceAssets(names[0]!, { site, into: values.into });
      print(values.json ? report : renderStage(report));
      return report.summary.errors ? 1 : undefined;
    }
    default: throw new ConfigError(`Unknown ${command} command ${operation}; use ${(kind === 'artifact' ? addonCommands : addonCommands.filter(item => !artifactOnly.has(item))).join(', ')}`);
  }
}

/** Text form of `verify`: package paths come from installed package listings, so they are JSON-quoted in drift lists. */
function renderVerify(command: string, report: VerifyReport): string {
  const status = (item: VerifyReport['addons'][number]): string => ({ match: 'files match addon-files.lock.json', modified: 'MODIFIED since recorded', stale: 'STALE: package-lock.json moved it', unrecorded: 'NOT RECORDED', linked: 'linked directory, not hashed', missing: 'not installed' })[item.files.status];
  return [
    `${command === 'extensions' ? 'Extensions' : 'Artifacts'} in ${report.site} (offline: compared with addon-files.lock.json):`,
    ...(report.addons.length ? report.addons.map(item => `  ${item.name} ${item.version ?? '(no version)'} ${item.package}: ${status(item)}${item.files.drift ? ` (${describeDrift(item.files.drift)})` : ''}`) : ['  none']),
    ...report.problems.map(problem => `Problem: ${problem}`),
  ].join('\n') + '\n';
}
function renderOutdated(command: string, report: OutdatedReport): string {
  return [
    `Independent ${command} in ${report.site} (asked the npm registry: a network operation):`,
    ...(report.addons.length ? report.addons.map(item => `  ${item.name} ${item.package} locked ${item.locked ?? '?'}${item.spec === null ? '' : `, spec ${JSON.stringify(item.spec)}`}: ${item.status === 'outdated' ? `${item.latest} available; upgrade with: ${item.upgrade}` : item.status === 'current' ? 'current' : item.message ?? item.status}`) : ['  none']),
    report.note,
  ].join('\n') + '\n';
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
    `Artifact ${artifact.name}: ${artifact.package} ${artifact.version ?? '(unknown version)'}${artifact.independent ? ', independent' : ''}; ${verified[artifact.verification]}${artifact.integrity ? ` (${artifact.integrity})` : ''}; ${artifact.files.status === 'match' ? `its ${artifact.files.recorded} files match addon-files.lock.json` : 'a linked directory, not hashed'}`,
    inspection.notice,
    'Documents:',
    ...(inspection.documents.length ? inspection.documents.flatMap(file) : ['  none listed in its urlcode.json']),
    ...(inspection.referencedFiles.length ? ['Referenced files:', ...inspection.referencedFiles.flatMap(file)] : []),
  ].join('\n') + '\n';
}

/** Text form of a staging report. Every source-supplied string is JSON-quoted, so it cannot pass for this output's own text. */
function renderStage(report: SourceStageReport): string {
  const { source, item, summary } = report;
  const q = (value: unknown): string => JSON.stringify(value);
  return [
    `Staged ${source.format} ${q(item.name)}${item.version === null ? '' : ` ${q(item.version)}`} from ${source.path} (${source.descriptor} sha256 ${source.descriptorSha256}${source.schema === null ? '' : `, $schema ${q(source.schema)}`})`,
    report.notice,
    report.inertNotice,
    `Files (${summary.files}: ${summary.code} code, ${summary.data} data, ${summary.docs} docs, ${summary.other} other; ${summary.bytes} bytes)${report.into === null ? '' : ` against ${report.into}`}:`,
    ...(report.files.length ? report.files.map(file => `  ${file.review ? 'REVIEW ' : ''}${file.class} ${q(file.target)} <- ${q(file.source)}${file.inline ? ' (inline content)' : ''} ${file.mediaType}, ${file.bytes} bytes, sha256 ${file.sha256}${file.role ? `, ${file.role}` : ''}${file.status ? ` [${file.status}]` : ''}`) : ['  none']),
    ...(report.dependencies.length ? ['npm dependencies (listed, never installed):', ...report.dependencies.map(dep => `  ${dep.kind} ${q(dep.spec)}${dep.declared === null ? '' : ` (site already declares ${q(dep.declared)})`}`)] : []),
    ...(report.registryDependencies.length ? ['Registry dependencies (listed, never resolved or fetched):', ...report.registryDependencies.map(dep => `  ${dep.kind} ${q(dep.spec)}`)] : []),
    ...(report.styles && Object.values(report.styles).some(value => value !== null) ? ['Style and configuration deltas (data, never applied):', ...Object.entries(report.styles).filter(([, value]) => value !== null).map(([key, value]) => `  ${key}: ${q(value)}`)] : []),
    ...(report.skill && Object.values(report.skill).some(value => value !== null) ? ['Skill frontmatter (data, never granted):', ...Object.entries(report.skill).filter(([, value]) => value !== null).map(([key, value]) => `  ${key}: ${q(value)}`)] : []),
    ...(report.install.dependencies || report.install.devDependencies ? ['An operator could run, after review (staging never does):', ...[report.install.dependencies, report.install.devDependencies].filter(Boolean).map(line => `  ${line}`)] : []),
    ...report.diagnostics.map(item => `${item.severity} ${item.code}${item.subject === undefined ? '' : ` ${q(item.subject)}`}: ${item.message}`),
    summary.errors ? `${summary.errors} error(s): --materialize would refuse this source.` : 'Write these files with: urlcode artifacts stage <source> --materialize --into <directory>',
  ].join('\n') + '\n';
}
function renderMaterialized(result: MaterializeResult): string {
  return [
    `Wrote ${result.written.length} file(s) under ${result.into}:`,
    ...result.written.map(file => `  ${file.class} ${JSON.stringify(file.target)} sha256 ${file.sha256}`),
    result.notice,
    ...[result.install.dependencies, result.install.devDependencies].filter(Boolean).map(line => `  ${line}`),
  ].join('\n') + '\n';
}
