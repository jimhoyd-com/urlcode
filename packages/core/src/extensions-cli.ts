import { installArtifact, inspectArtifacts } from './extension-artifacts.ts';
import { installBundle, readBundleLock, BUNDLE_CATALOG_NAMES, createLocalBundleTransport } from './extension-bundles.ts';
import { ConfigError } from './errors.ts';

type ExtensionCliOptions = {
  project: string;
  json?: boolean;
  'artifact-release'?: string;
  'bundle-release'?: string;
  'bundle-release-path'?: string;
};

type Print = (value: unknown) => boolean;

function formatBundleCatalogNames(): string {
  const lines = [
    'First-party extension bundle names (static, this core release):',
    ...BUNDLE_CATALOG_NAMES.map(item => `  ${item.name}: ${item.description}`),
    '',
    'Install with: urlcode init <directory> --with name[,name] (auto-resolves extension-bundles@v<core>), or',
    'urlcode extension-bundles install <name> --bundle-release extension-bundles@vX.Y.Z',
  ];
  return lines.join('\n') + '\n';
}

export async function runExtensionCommand(command: 'extension-artifacts' | 'extension-bundles', operation: string | undefined, extra: string[], values: ExtensionCliOptions, print: Print): Promise<void> {
  if (command === 'extension-artifacts') {
    if (operation === 'install' || operation === 'update') {
      const artifact = extra[0];
      if (!artifact || extra.length !== 1) throw new ConfigError(`Use urlcode extension-artifacts ${operation} <name> --artifact-release extensions@vX.Y.Z`);
      if (!values['artifact-release']) throw new ConfigError('Use --artifact-release with an immutable extension release tag');
      const lock = await installArtifact(values.project, values['artifact-release'], artifact);
      print(values.json ? lock : { event: operation === 'install' ? 'extension-artifact-installed' : 'extension-artifact-updated', name: artifact, lockfile: 'urlcode.extensions.lock.json' });
    } else if (operation === 'inspect') {
      if (extra.length) throw new ConfigError('Use urlcode extension-artifacts inspect');
      const report = await inspectArtifacts(values.project);
      print(values.json ? report : { artifacts: report.lock.artifacts.map(item => ({ ...item, status: report.cached.includes(item.name) ? 'cached' : report.invalid.includes(item.name) ? 'invalid' : 'missing' })) });
    } else {
      throw new ConfigError('Use extension-artifacts install, update or inspect');
    }
    return;
  }

  if (operation === 'install') {
    const bundle = extra[0];
    if (!bundle || extra.length !== 1) throw new ConfigError('Use urlcode extension-bundles install <name> --bundle-release extension-bundles@vX.Y.Z');
    if (!values['bundle-release']) throw new ConfigError('Use --bundle-release with an immutable extension bundle release tag');
    const transport = values['bundle-release-path'] !== undefined ? createLocalBundleTransport(values['bundle-release-path']) : undefined;
    const lock = await installBundle(values.project, values['bundle-release'], bundle, transport);
    print(values.json ? lock : { event: 'extension-bundle-installed', name: bundle, lockfile: 'urlcode.extension-bundles.lock.json' });
  } else if (operation === 'inspect') {
    if (extra.length) throw new ConfigError('Use urlcode extension-bundles inspect');
    const lock = await readBundleLock(values.project);
    print(values.json ? lock : { bundles: lock.bundles.map(item => ({ name: item.name, version: item.version, release: item.catalog.tag, coreVersion: item.coreVersion })) });
  } else if (operation === 'list') {
    if (extra.length) throw new ConfigError('Use urlcode extension-bundles list');
    print(values.json ? BUNDLE_CATALOG_NAMES : formatBundleCatalogNames());
  } else {
    throw new ConfigError('Use extension-bundles install, inspect or list');
  }
}
