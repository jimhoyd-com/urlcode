import { availableArtifacts, installArtifact, inspectArtifacts } from './extension-artifacts.ts';
import { availableBundles, installBundle, readBundleLock, resolveBundleExecutable, BUNDLE_CATALOG_NAMES, createLocalBundleTransport, runningCoreVersion } from './extension-bundles.ts';
import { ConfigError } from './errors.ts';
import { resolveSafeReleaseTrain, safeReleaseTrainTag, type SafeReleaseTrain } from './release-train.ts';

type ExtensionCliOptions = {
  project: string;
  json?: boolean;
  'artifact-release'?: string;
  'bundle-release'?: string;
  'bundle-release-path'?: string;
  'release-train'?: string;
};

type Print = (value: unknown) => boolean;

type Component = 'artifacts' | 'bundles';
type SafeTrainResolver = (release:string, coreVersion:string) => Promise<SafeReleaseTrain>;
type CoreVersionReader = () => Promise<string>;

/** Resolve an explicit component pin, or the component endorsed by this core's signed safe train. */
export async function resolveExtensionRelease(component:Component, explicit:string|undefined, requestedTrain:string|undefined, dependencies:{runningCoreVersion?:CoreVersionReader;resolveSafeReleaseTrain?:SafeTrainResolver;safeReleaseTrainTag?:(coreVersion:string)=>string}={}):Promise<{release:string;train?:SafeReleaseTrain}> {
  if (explicit) return {release:explicit};
  const coreVersion=await (dependencies.runningCoreVersion ?? runningCoreVersion)();
  const tag=(dependencies.safeReleaseTrainTag ?? safeReleaseTrainTag)(coreVersion);
  const train=await (dependencies.resolveSafeReleaseTrain ?? resolveSafeReleaseTrain)(requestedTrain ?? tag,coreVersion);
  return {release:component==='bundles'?train.extensionBundles.tag:train.artifacts.tag,train};
}

function formatBundleCatalogNames(command = 'extension-bundles'): string {
  const lines = [
    'First-party extension bundle names (static, this core release):',
    ...BUNDLE_CATALOG_NAMES.map(item => `  ${item.name}: ${item.description}`),
    '',
    'Install with: urlcode init <directory> --with name[,name] (auto-resolves extension-bundles@v<core>), or',
    `urlcode ${command} install <name> --bundle-release extension-bundles@vX.Y.Z`,
  ];
  return lines.join('\n') + '\n';
}

/**
 * Runs the extension-artifacts/extension-bundles subcommands. Returns a process exit code only for `run` (which
 * spawns another process and must propagate its status); every other operation prints and returns undefined,
 * leaving the caller's own exit code alone.
 */
export async function runExtensionCommand(command: 'artifacts' | 'extension-artifacts' | 'extensions' | 'extension-bundles', operation: string | undefined, extra: string[], values: ExtensionCliOptions, print: Print, dependencies?:Parameters<typeof resolveExtensionRelease>[3]): Promise<number | undefined> {
  const artifacts = command === 'artifacts' || command === 'extension-artifacts';
  const commandName = artifacts ? command : command;
  if (artifacts) {
    const inspectOperation = operation === 'list' || operation === 'status' ? 'inspect' : operation;
    if (inspectOperation === 'available') {
      if (extra.length) throw new ConfigError(`Use urlcode ${commandName} available [--release-train urlcode-train@vX.Y.Z|--artifact-release extensions@vX.Y.Z]`);
      const selected=await resolveExtensionRelease('artifacts',values['artifact-release'],values['release-train'],dependencies);
      const catalog = await availableArtifacts(selected.release);
      print(values.json ? { release:catalog.tag, releaseTrain:selected.train?.tag, artifacts:catalog.artifacts } : { release:catalog.tag, releaseTrain:selected.train?.tag, artifacts:catalog.artifacts.map(item => ({ name:item.name, version:item.version, kind:item.kind })) });
      return undefined;
    }
    if (inspectOperation === 'install' || inspectOperation === 'update') {
      const artifact = extra[0];
      if (!artifact || extra.length !== 1) throw new ConfigError(`Use urlcode ${commandName} ${inspectOperation} <name> [--release-train urlcode-train@vX.Y.Z|--artifact-release extensions@vX.Y.Z]`);
      const selected=await resolveExtensionRelease('artifacts',values['artifact-release'],values['release-train'],dependencies);
      const lock = await installArtifact(values.project, selected.release, artifact);
      print(values.json ? lock : { event: inspectOperation === 'install' ? 'extension-artifact-installed' : 'extension-artifact-updated', name: artifact, lockfile: 'urlcode.extensions.lock.json' });
    } else if (inspectOperation === 'inspect') {
      if (extra.length) throw new ConfigError(`Use urlcode ${commandName} ${operation}`);
      const report = await inspectArtifacts(values.project);
      print(values.json ? report : { artifacts: report.lock.artifacts.map(item => ({ ...item, status: report.cached.includes(item.name) ? 'cached' : report.invalid.includes(item.name) ? 'invalid' : 'missing' })) });
    } else {
      throw new ConfigError(`Use ${commandName} available, install, update, list or status`);
    }
    return undefined;
  }

  // `extension-bundles list` remains the legacy static catalog command.  In
  // the new noun-first namespace, `available` owns catalog discovery and
  // `list`/`status` describe the project's locked bundles.
  const inspectOperation = command === 'extensions' && (operation === 'list' || operation === 'status') ? 'inspect' : operation;
  if (inspectOperation === 'install') {
    const bundle = extra[0];
    if (!bundle || extra.length !== 1) throw new ConfigError(`Use urlcode ${commandName} install <name> [--release-train urlcode-train@vX.Y.Z|--bundle-release extension-bundles@vX.Y.Z]`);
    const selected=await resolveExtensionRelease('bundles',values['bundle-release'],values['release-train'],dependencies);
    const transport = values['bundle-release-path'] !== undefined ? createLocalBundleTransport(values['bundle-release-path']) : undefined;
    const lock = await installBundle(values.project, selected.release, bundle, transport);
    print(values.json ? lock : { event: 'extension-bundle-installed', name: bundle, lockfile: 'urlcode.extension-bundles.lock.json' });
  } else if (inspectOperation === 'inspect') {
    if (extra.length) throw new ConfigError(`Use urlcode ${commandName} ${operation}`);
    const lock = await readBundleLock(values.project);
    print(values.json ? lock : { bundles: lock.bundles.map(item => ({ name: item.name, version: item.version, release: item.catalog.tag, coreVersion: item.coreVersion })) });
  } else if (operation === 'available') {
    if (extra.length) throw new ConfigError(`Use urlcode ${commandName} ${operation}`);
    const selected=await resolveExtensionRelease('bundles',values['bundle-release'],values['release-train'],dependencies);
    const catalog=await availableBundles(selected.release);
    print(values.json ? { release:catalog.tag, releaseTrain:selected.train?.tag, bundles:catalog.bundles } : { release:catalog.tag, releaseTrain:selected.train?.tag, bundles:catalog.bundles.map(item=>({name:item.name,version:item.version})) });
  } else if (command === 'extension-bundles' && operation === 'list') {
    if (extra.length) throw new ConfigError(`Use urlcode ${commandName} ${operation}`);
    print(values.json ? BUNDLE_CATALOG_NAMES : formatBundleCatalogNames(commandName));
  } else if (inspectOperation === 'run') {
    // <name> is the locked bundle; everything else forwards verbatim to its own packaged CLI, spawned from the
    // verified, cached bytes -- a bundle-only site has no npm install of that CLI's package for a plain npx to find.
    const [bundle, ...forwarded] = extra;
    if (!bundle) throw new ConfigError(`Use urlcode ${commandName} run <name> [--project directory] -- <args>`);
    const script = await resolveBundleExecutable(values.project, bundle);
    const { spawn } = await import('node:child_process');
    return new Promise<number>(settle => {
      const child = spawn(process.execPath, [script, ...forwarded], { stdio: 'inherit' });
      child.on('error', () => settle(1));
      child.on('exit', (status, signal) => settle(status ?? (signal ? 1 : 0)));
    });
  } else {
    throw new ConfigError(`Use ${commandName} available, install, list, status or run`);
  }
  return undefined;
}
