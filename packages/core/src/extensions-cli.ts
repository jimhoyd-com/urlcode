import { availableArtifacts, installArtifact, inspectArtifacts } from './artifacts.ts';
import { availableBundles, installBundle, readBundleLock, resolveBundleExecutable, BUNDLE_CATALOG_NAMES, createLocalBundleTransport, runningCoreVersion } from './extension-bundles.ts';
import { ConfigError } from './errors.ts';

type ExtensionCliOptions = {
  project: string;
  json?: boolean;
  'artifact-release'?: string;
  'bundle-release'?: string;
  'bundle-release-path'?: string;
};

type Print = (value: unknown) => boolean;

type Component = 'artifacts' | 'bundles';
type CoreVersionReader = () => Promise<string>;

/** Each core release owns the exact extension and artifact catalogs it recommends. */
export async function resolveExtensionRelease(component:Component, explicit:string|undefined, dependencies:{runningCoreVersion?:CoreVersionReader}={}):Promise<{release:string}> {
  if (explicit) return {release:explicit};
  const coreVersion=await (dependencies.runningCoreVersion ?? runningCoreVersion)();
  return {release:`${component==='bundles'?'extension-bundles':'extensions'}@v${coreVersion}`};
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
 * Runs the artifacts/extension-bundles subcommands. Returns a process exit code only for `run` (which
 * spawns another process and must propagate its status); every other operation prints and returns undefined,
 * leaving the caller's own exit code alone.
 */
export async function runExtensionCommand(command: 'artifacts' | 'extension-artifacts' | 'extensions' | 'extension-bundles', operation: string | undefined, extra: string[], values: ExtensionCliOptions, print: Print, dependencies?:Parameters<typeof resolveExtensionRelease>[2]): Promise<number | undefined> {
  const artifacts = command === 'artifacts' || command === 'extension-artifacts';
  const commandName = artifacts ? command : command;
  if (artifacts) {
    const inspectOperation = operation === 'list' || operation === 'status' ? 'inspect' : operation;
    if (inspectOperation === 'available') {
      if (extra.length) throw new ConfigError(`Use urlcode ${commandName} available [--artifact-release extensions@vX.Y.Z]`);
      const selected=await resolveExtensionRelease('artifacts',values['artifact-release'],dependencies);
      const catalog = await availableArtifacts(selected.release);
      print(values.json ? { release:catalog.tag, artifacts:catalog.artifacts } : { release:catalog.tag, artifacts:catalog.artifacts.map(item => ({ name:item.name, version:item.version, kind:item.kind })) });
      return undefined;
    }
    const changeOperation = inspectOperation === 'add' ? 'install' : inspectOperation;
    if (changeOperation === 'install' || changeOperation === 'update') {
      const artifact = extra[0];
      if (!artifact || extra.length !== 1) throw new ConfigError(`Use urlcode ${commandName} ${operation} <name> [--artifact-release extensions@vX.Y.Z]`);
      const selected=await resolveExtensionRelease('artifacts',values['artifact-release'],dependencies);
      const lock = await installArtifact(values.project, selected.release, artifact);
      print(values.json ? lock : { event: changeOperation === 'install' ? 'extension-artifact-installed' : 'extension-artifact-updated', name: artifact, lockfile: 'urlcode.extensions.lock.json' });
    } else if (inspectOperation === 'inspect') {
      if (extra.length) throw new ConfigError(`Use urlcode ${commandName} ${operation}`);
      const report = await inspectArtifacts(values.project);
      print(values.json ? report : { artifacts: report.lock.artifacts.map(item => ({ ...item, status: report.cached.includes(item.name) ? 'cached' : report.invalid.includes(item.name) ? 'invalid' : 'missing' })) });
    } else {
      throw new ConfigError(`Use ${commandName} available, add, install, update, list or status`);
    }
    return undefined;
  }

  // `extension-bundles list` remains the legacy static catalog command.  In
  // the new noun-first namespace, `available` owns catalog discovery and
  // `list`/`status` describe the project's locked bundles.
  const inspectOperation = command === 'extensions' && (operation === 'list' || operation === 'status') ? 'inspect' : operation;
  const changeOperation = inspectOperation === 'add' ? 'install' : inspectOperation;
  if (changeOperation === 'install') {
    const bundle = extra[0];
    if (!bundle || extra.length !== 1) throw new ConfigError(`Use urlcode ${commandName} ${operation} <name> [--bundle-release extension-bundles@vX.Y.Z]`);
    const selected=await resolveExtensionRelease('bundles',values['bundle-release'],dependencies);
    const transport = values['bundle-release-path'] !== undefined ? createLocalBundleTransport(values['bundle-release-path']) : undefined;
    const lock = await installBundle(values.project, selected.release, bundle, transport);
    print(values.json ? lock : { event: 'extension-bundle-installed', name: bundle, lockfile: 'urlcode.extension-bundles.lock.json' });
  } else if (inspectOperation === 'inspect') {
    if (extra.length) throw new ConfigError(`Use urlcode ${commandName} ${operation}`);
    const lock = await readBundleLock(values.project);
    print(values.json ? lock : { bundles: lock.bundles.map(item => ({ name: item.name, version: item.version, release: item.catalog.tag, coreVersion: item.coreVersion })) });
  } else if (operation === 'available') {
    if (extra.length) throw new ConfigError(`Use urlcode ${commandName} ${operation}`);
    const selected=await resolveExtensionRelease('bundles',values['bundle-release'],dependencies);
    const catalog=await availableBundles(selected.release);
    print(values.json ? { release:catalog.tag, bundles:catalog.bundles } : { release:catalog.tag, bundles:catalog.bundles.map(item=>({name:item.name,version:item.version})) });
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
    throw new ConfigError(`Use ${commandName} available, add, install, list, status or run`);
  }
  return undefined;
}
