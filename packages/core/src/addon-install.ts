import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { parseDocument, stringify } from 'yaml';
import { loadDocument, parseYaml, validateDocument } from './config.ts';
import { ConfigError, assert } from './errors.ts';
import { effectiveExtensionPolicies, inspectExtensionRevision } from './extensions.ts';
import type { DefinedExtension, ExtensionDefinition, ScaffoldResult } from './extensions.ts';
import { orderByRequires } from './host.ts';
import { runNpm } from './npm.ts';
import { isCode, isRecord } from './object-guards.ts';
import { addonNamePattern, addonPackage, isDevelopmentManifest, parseDescriptor, readAddonManifest, withRequirements } from './addon-manifest.ts';
import type { AddonDescriptor, AddonKind, AddonManifest, AddonPin } from './addon-manifest.ts';

/**
 * A site is the one project layout: `package.json` (exact core pin plus add-on tarball URLs), `host.mjs` (the
 * trusted operator host, outside the route project) and `app/` (the route project holding urlcode.yaml).
 * `extensions add|remove` and `artifacts add|remove` install through npm, check each lock entry against the pin in
 * core's own `addons.json`, and for an extension also write its configuration, routes, operator files and host.mjs
 * line. Every change is rolled back if any step fails, node_modules included.
 */
export const PROJECT_DIRECTORY = 'app', HOST_FILE = 'host.mjs';
const acknowledgementPattern = /^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/;
const hostOpener = 'export default await composeHost(import.meta.url, [';
const reserved = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'composeHost']);

export interface Site { site: string; project: string; hostFile: string; packageFile: string }
export function sitePaths(directory: string): Site {
  const site = resolve(directory);
  return { site, project: join(site, PROJECT_DIRECTORY), hostFile: join(site, HOST_FILE), packageFile: join(site, 'package.json') };
}
export async function openSite(directory: string): Promise<Site> {
  const paths = sitePaths(directory);
  for (const [path, what] of [[paths.packageFile, 'package.json'], [paths.hostFile, HOST_FILE], [join(paths.project, 'urlcode.yaml'), `${PROJECT_DIRECTORY}/urlcode.yaml`]] as const) {
    try { await lstat(path); } catch (error) { if (isCode(error, 'ENOENT')) throw new ConfigError(`${paths.site} is not a URLCode site: ${what} is missing. Create one with \`urlcode init <directory>\`, or pass --site`, { code: 'no-project' }); throw error; }
  }
  return paths;
}

/** The host.mjs `urlcode init` writes. `extensions add|remove` edit its import lines and the list, one line each. */
export function renderInitialHost(): string {
  return [
    '// Trusted operator host: keep it outside app/ and review it like any other code you deploy.',
    '// `urlcode extensions add|remove` edits the import lines and the list below; pass operator options inside a call, for example auth({...}).',
    "import { composeHost } from '@jimhoyd/urlcode/host';",
    '',
    hostOpener,
    ']);',
    '',
  ].join('\n');
}
export function hostIdentifier(name: string): string {
  const camel = name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
  return reserved.has(camel) ? `${camel}Extension` : camel;
}
const importLine = (name: string): string => `import ${hostIdentifier(name)} from '${addonPackage(name)}/extension';`;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function hostWithExtension(text: string, name: string): string {
  const lines = text.split('\n'), id = hostIdentifier(name);
  if (lines.includes(importLine(name))) return text;
  const opener = lines.indexOf(hostOpener);
  const closer = opener < 0 ? -1 : lines.findIndex((line, index) => index > opener && /^\](?:\)|,)/.test(line));
  if (opener < 0 || closer < 0) throw new ConfigError(`${HOST_FILE} no longer has the \`${hostOpener}\` … \`]);\` list; add these two lines yourself:\n  ${importLine(name)}\n    ${id}(),`);
  lines.splice(closer, 0, `  ${id}(),`);
  const lastImport = lines.reduce((last, line, index) => line.startsWith('import ') && index < opener ? index : last, -1);
  lines.splice(lastImport + 1, 0, importLine(name));
  return lines.join('\n');
}
export function hostWithoutExtension(text: string, name: string): string {
  const lines = text.split('\n'), id = hostIdentifier(name);
  const imports = lines.flatMap((line, index) => line === importLine(name) ? [index] : []);
  const calls = lines.flatMap((line, index) => new RegExp(`^\\s*${escape(id)}\\(.*\\),?\\s*$`).test(line) ? [index] : []);
  if (imports.length !== 1 || calls.length !== 1) throw new ConfigError(`${HOST_FILE} does not have exactly one \`${importLine(name)}\` line and one single-line \`${id}(…),\` entry; remove ${name} from ${HOST_FILE} yourself, then run this command again`);
  return lines.filter((_, index) => index !== imports[0] && index !== calls[0]).join('\n');
}

export interface PackageJson { dependencies?: Record<string, string>; [key: string]: unknown }
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
export const renderJson = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
interface LockEntry { version?: string; resolved?: string; integrity?: string; link?: boolean }
export async function lockPackages(site: string): Promise<Record<string, LockEntry>> {
  let raw: unknown;
  try { raw = await readJson(join(site, 'package-lock.json')); } catch (error) { if (isCode(error, 'ENOENT')) return {}; throw error; }
  return isRecord(raw) && isRecord(raw.packages) ? raw.packages as Record<string, LockEntry> : {};
}
/** Why `pkg`'s lock entry does not match its pin, or undefined when it does. */
export function pinProblem(lock: Record<string, LockEntry>, pin: AddonPin): string | undefined {
  const entry = lock[`node_modules/${pin.package}`];
  if (!entry) return `${pin.package} is not in package-lock.json`;
  if (pin.integrity === null) return entry.link || entry.resolved?.startsWith('file:') ? undefined : `${pin.package} should link the development source ${pin.url}`;
  if (entry.integrity !== pin.integrity) return `${pin.package} integrity ${entry.integrity ?? '(none)'} does not match core's pin ${pin.integrity}`;
  if (pin.url.startsWith('https:') && entry.resolved !== pin.url) return `${pin.package} resolved from ${entry.resolved ?? '(unknown)'}, not ${pin.url}`;
  return undefined;
}
/** Every `@jimhoyd/urlcode*` package installed somewhere other than the site's top level: a nested copy. */
export function nestedCopies(lock: Record<string, LockEntry>): string[] {
  return Object.keys(lock).filter(key => /node_modules\/.+\/node_modules\/@jimhoyd\/urlcode(?:-[a-z0-9-]+)?$/.test(key)).sort();
}

/**
 * The only keys an artifact's package.json may carry: identity, notices and the file list. An allowlist, not a
 * blocklist, because npm keeps growing fields that install or run something (peerDependencies, workspaces,
 * overrides, bin, scripts…); anything not named here is refused.
 */
export const artifactManifestKeys: ReadonlySet<string> = new Set(['name', 'version', 'description', 'keywords', 'homepage', 'bugs', 'license', 'author', 'contributors', 'repository', 'private', 'files']);
/** package-lock.json fields that mean an entry pulls something in or runs something; an artifact's entry has none. */
const lockDependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'bin', 'hasInstallScript'];
/** Why an artifact's own lock entry (and, for a linked directory, its target's entry) is not inert, or undefined. */
export function artifactLockProblem(lock: Record<string, LockEntry>, pin: AddonPin): string | undefined {
  const entry = lock[`node_modules/${pin.package}`];
  if (!entry) return undefined;
  const target = entry.link && typeof entry.resolved === 'string' ? lock[entry.resolved] : undefined;
  for (const item of [entry, target]) {
    const field = item && lockDependencyFields.find(key => (item as Record<string, unknown>)[key] !== undefined);
    if (field) return `${pin.package} declares ${field} in package-lock.json; artifacts never execute or pull anything in`;
  }
  return undefined;
}

const artifactFile = /^(?:package\.json|urlcode\.json|README\.md|LICENSE|NOTICE|SECURITY\.md|(?:schemas|config)\/[A-Za-z0-9._-]+\.json)$/;
/** An artifact is inert: only its descriptor, notices and JSON data, and a manifest that can neither run nor pull anything in. */
export async function assertInertArtifact(directory: string, name: string): Promise<void> {
  const root = await realpath(directory), files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), rel = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) { await walk(path); continue; }
      assert(entry.isFile() && artifactFile.test(rel), `Artifact ${name} contains ${rel}, which is not declarative data; artifacts may hold only JSON data, their descriptor and notices`);
      assert((await lstat(path)).size <= 2 * 1024 * 1024, `Artifact ${name} file ${rel} is larger than 2 MiB`);
      if (rel.endsWith('.json')) { try { JSON.parse(await readFile(path, 'utf8')); } catch { throw new ConfigError(`Artifact ${name} has invalid JSON in ${rel}`); } }
      files.push(rel);
    }
  };
  await walk(root);
  assert(files.length <= 128, `Artifact ${name} has too many files`);
  const manifest = await readJson<unknown>(join(root, 'package.json'));
  assert(isRecord(manifest), `Artifact ${name} package.json is not an object`);
  for (const key of Object.keys(manifest)) assert(artifactManifestKeys.has(key), `Artifact ${name} package.json declares ${key}; an artifact's package.json may declare only ${[...artifactManifestKeys].join(', ')}, so it can never execute or pull anything in`);
  const descriptor = parseDescriptor(await readJson(join(root, 'urlcode.json')), `${name}/urlcode.json`);
  assert(descriptor.kind === 'artifact' && descriptor.name === name, `${name}/urlcode.json does not describe artifact ${name}`);
}

/**
 * After an install: each named artifact's lock entry declares nothing that installs or runs, and its installed
 * directory is inert. The first failure refuses with `Refusing <name>: …`. Used by `add` and `upgrade`.
 */
export async function assertInertArtifacts(site: string, lock: Record<string, LockEntry>, manifest: AddonManifest, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const problem = artifactLockProblem(lock, manifest.addons[name]!);
    if (problem) throw new ConfigError(`Refusing ${name}: ${problem}`);
    try { await assertInertArtifact(join(site, 'node_modules', addonPackage(name)), name); }
    catch (error) { throw new ConfigError(`Refusing ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

async function loadDefinition(site: string, name: string): Promise<ExtensionDefinition<unknown>> {
  let path: string;
  try { path = createRequire(join(site, 'package.json')).resolve(`${addonPackage(name)}/extension`); }
  catch { throw new ConfigError(`${addonPackage(name)} is installed but has no ./extension entry`); }
  const module = await import(pathToFileURL(path).href) as { default?: DefinedExtension<unknown> };
  const definition = module.default?.definition;
  assert(definition && definition.name === name, `${addonPackage(name)}/extension must default-export defineExtension({name: '${name}', …})`);
  return definition;
}
export async function readInstalledDescriptor(site: string, name: string): Promise<AddonDescriptor | undefined> {
  const path = join(site, 'node_modules', addonPackage(name), 'urlcode.json');
  try { return parseDescriptor(await readJson(path), path); } catch (error) { if (isCode(error, 'ENOENT')) return undefined; throw error; }
}

function scaffoldPath(site: string, path: string): string {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.includes('\0') && !path.startsWith('/'), `Invalid scaffold file path ${path}`);
  const target = resolve(site, path), rel = relative(site, target);
  assert(rel === path.split('/').join(sep) && rel.length > 0 && !rel.startsWith('..'), `Scaffold file path must stay inside the site: ${path}`);
  assert(rel !== PROJECT_DIRECTORY && !rel.startsWith(PROJECT_DIRECTORY + sep) && rel !== 'node_modules' && !rel.startsWith('node_modules' + sep), `Scaffold files must stay outside app/ and node_modules/: ${path}`);
  return target;
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; } }
async function writeExclusive(target: string, content: string | Uint8Array, mode: number, site: string): Promise<void> {
  for (let probe = dirname(target); probe !== site && probe.startsWith(site); probe = dirname(probe)) {
    try { assert(!(await lstat(probe)).isSymbolicLink(), `Scaffold path passes through a symlink: ${relative(site, target)}`); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const file = await open(target, 'wx', mode);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

export interface Snapshot { restore(): Promise<void>; created: string[] }
export async function snapshot(paths: readonly string[]): Promise<Snapshot> {
  const saved = new Map<string, string | undefined>();
  for (const path of paths) { try { saved.set(path, await readFile(path, 'utf8')); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; saved.set(path, undefined); } }
  const created: string[] = [];
  return {
    created,
    async restore() {
      for (const path of [...created].reverse()) await rm(path, { force: true });
      for (const [path, text] of saved) { if (text === undefined) await rm(path, { force: true }); else await writeFile(path, text); }
    },
  };
}

/**
 * What the site's dependency tree held before a command ran npm, so a refused command puts node_modules back too,
 * not only package.json and the lock. With a lock, the restored lock is reinstalled exactly (`npm ci`); without one,
 * every top-level node_modules entry the command created is removed (and node_modules itself if it was absent).
 */
export interface DependencyTree { hadLock: boolean; lock: Record<string, LockEntry>; restore(): Promise<void> }
async function topLevelModules(modules: string): Promise<Set<string> | undefined> {
  let names: string[];
  try { names = await readdir(modules); } catch (error) { if (isCode(error, 'ENOENT')) return undefined; throw error; }
  const entries = new Set<string>();
  for (const name of names) {
    entries.add(name);
    if (name.startsWith('@') && (await lstat(join(modules, name))).isDirectory()) for (const inner of await readdir(join(modules, name))) entries.add(`${name}/${inner}`);
  }
  return entries;
}
export async function dependencyTree(site: string): Promise<DependencyTree> {
  const hadLock = await exists(join(site, 'package-lock.json')), lock = await lockPackages(site);
  const modules = join(site, 'node_modules'), before = hadLock ? undefined : await topLevelModules(modules);
  return {
    hadLock, lock,
    async restore() {
      if (hadLock) { await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], site); return; }
      if (!before) { await rm(modules, { recursive: true, force: true }); return; }
      const after = await topLevelModules(modules) ?? new Set<string>();
      // Scoped entries first, then the scope directories this command created.
      for (const entry of [...after].sort((a, b) => b.length - a.length)) if (!before.has(entry)) await rm(join(modules, entry), { recursive: true, force: true });
    },
  };
}
/**
 * Restores the files, then, when npm ran, the dependency tree; a tree that cannot be restored is named, never hidden.
 * Shared by `add`, `remove` and `upgrade`; internal to core.
 */
export async function rollBack(state: Snapshot, tree: DependencyTree | undefined, site: string, error: unknown): Promise<never> {
  await state.restore();
  if (tree) {
    try { await tree.restore(); }
    catch (restoreError) {
      const why = restoreError instanceof Error ? restoreError.message : String(restoreError), what = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`${what}\npackage.json and package-lock.json were restored, but node_modules was not (${why}); run \`npm ci --ignore-scripts\` in ${site} before continuing`);
    }
  }
  throw error;
}

function managedNames(manifest: AddonManifest, pkg: PackageJson, kind?: AddonKind): string[] {
  const deps = pkg.dependencies ?? {};
  return Object.entries(manifest.addons).filter(([, pin]) => Object.hasOwn(deps, pin.package) && (kind === undefined || pin.kind === kind)).map(([name]) => name).sort();
}
const kindNoun = (kind: AddonKind): string => kind === 'extension' ? 'extensions' : 'artifacts';

export interface AddOptions {
  acknowledgements?: readonly string[] | undefined;
  /** The command that would proceed with one more acknowledgement; `init --with` passes its own. */
  retry?: ((acknowledgements: readonly string[]) => string) | undefined;
  /** Test/offline seam: an already-read manifest. */
  manifest?: AddonManifest | undefined;
}
export interface AddResult { added: string[]; alreadyInstalled: string[]; projectSha256: string | undefined; env: Record<string, string>; notes: string[]; keptFiles: string[]; development: boolean }

/**
 * `urlcode extensions add` / `urlcode artifacts add`. Names of the other kind refuse. Requirements are added too,
 * in dependency order, each exactly once at the top level of the site.
 */
export async function addAddons(directory: string, kind: AddonKind, requested: readonly string[], options: AddOptions = {}): Promise<AddResult> {
  assert(requested.length > 0 && requested.every(name => addonNamePattern.test(name)), `Name at least one ${kind}`);
  const site = await openSite(directory), manifest = options.manifest ?? await readAddonManifest();
  const acknowledgements = [...new Set(options.acknowledgements ?? [])].sort();
  assert(acknowledgements.every(id => acknowledgementPattern.test(id)), 'Use --ack <extension>:<id>, for example --ack store:public-write');
  for (const name of requested) {
    const pin = manifest.addons[name];
    if (!pin || pin.kind !== kind) {
      const valid = Object.entries(manifest.addons).filter(([, item]) => item.kind === kind).map(([key]) => key).sort();
      throw new ConfigError(pin ? `${name} is an ${pin.kind}; use \`urlcode ${kindNoun(pin.kind)} add ${name}\`` : `Unknown ${kind} ${name}; this core (${manifest.version}) has: ${valid.join(', ') || 'none'}`);
    }
  }
  const pkg = await readJson<PackageJson>(site.packageFile);
  const before = new Set(managedNames(manifest, pkg));
  const wanted = withRequirements(manifest, requested);
  const toAdd = wanted.filter(name => !before.has(name) || pkg.dependencies?.[manifest.addons[name]!.package] !== manifest.addons[name]!.url);
  const result: AddResult = { added: [], alreadyInstalled: wanted.filter(name => !toAdd.includes(name)), projectSha256: undefined, env: {}, notes: [], keptFiles: [], development: isDevelopmentManifest(manifest) };
  if (!toAdd.length) { assert(acknowledgements.length === 0, `--ack ${acknowledgements.join(', ')} has no effect: ${requested.join(', ')} is already installed`); return result; }
  const yamlFile = join(site.project, 'urlcode.yaml');
  const state = await snapshot([site.packageFile, join(site.site, 'package-lock.json'), yamlFile, site.hostFile]);
  const tree = await dependencyTree(site.site);
  const secrets: Uint8Array[] = [];
  let installing = false;
  try {
    pkg.dependencies = { ...pkg.dependencies };
    for (const name of toAdd) pkg.dependencies[manifest.addons[name]!.package] = manifest.addons[name]!.url;
    await writeFile(site.packageFile, renderJson(pkg));
    installing = true;
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], site.site);
    const lock = await lockPackages(site.site);
    for (const name of toAdd) { const problem = pinProblem(lock, manifest.addons[name]!); if (problem) throw new ConfigError(`Refusing ${name}: ${problem}`); }
    const nested = nestedCopies(lock);
    assert(!nested.length, `An add-on was installed as a nested copy (${nested.join(', ')}); every add-on must resolve once, at the top level of the site`);
    const artifacts = toAdd.filter(name => manifest.addons[name]!.kind === 'artifact');
    await assertInertArtifacts(site.site, lock, manifest, artifacts);
    if (tree.hadLock && artifacts.length === toAdd.length) {
      // Belt and braces: adding only artifacts to a locked site may add their own entries to the lock and nothing else.
      const own = new Set(artifacts.flatMap(name => { const key = `node_modules/${manifest.addons[name]!.package}`, entry = lock[key]; return entry?.link && typeof entry.resolved === 'string' ? [key, entry.resolved] : [key]; }));
      const extra = Object.keys(lock).filter(key => key !== '' && !own.has(key) && !Object.hasOwn(tree.lock, key)).sort();
      assert(!extra.length, `Refusing ${artifacts.join(', ')}: npm install also added ${extra.join(', ')} to package-lock.json, which no artifact accounts for; artifacts never pull anything in. If your own package.json changes added them, run npm install first, then add the artifact again`);
    }

    const newExtensions = toAdd.filter(name => manifest.addons[name]!.kind === 'extension');
    if (newExtensions.length) {
      const installed = [...new Set([...managedNames(manifest, pkg, 'extension')])].sort();
      const definitions = new Map<string, ExtensionDefinition<unknown>>();
      for (const name of newExtensions) definitions.set(name, await loadDefinition(site.site, name));
      const ordered = orderByRequires(newExtensions.map(name => ({ name, requires: (definitions.get(name)!.requires ?? []).filter(requirement => newExtensions.includes(requirement)) })), (item, requirement) => `${item.name} requires ${requirement}`);
      const loaded = await loadDocument(site.project);
      const scaffolds: { name: string; result: ScaffoldResult }[] = [];
      for (const { name } of ordered) {
        const definition = definitions.get(name)!;
        for (const requirement of definition.requires ?? []) assert(installed.includes(requirement), `${name} requires ${requirement}`);
        assert(!Object.hasOwn(loaded.document.extensions ?? {}, name), `${PROJECT_DIRECTORY}/urlcode.yaml already declares extensions.${name}; remove that block first`);
        let scaffold: ScaffoldResult = { config: {}, routes: {} };
        if (definition.scaffold) {
          try { scaffold = await definition.scaffold({ site: site.site, project: site.project, installed, acknowledgements }); }
          catch (error) {
            const id = isRecord(error) ? error.acknowledgement : undefined, message = error instanceof Error ? error.message : String(error);
            if (typeof id === 'string' && acknowledgementPattern.test(id) && id.startsWith(`${name}:`) && !acknowledgements.includes(id)) {
              const retry = options.retry ?? ((acks: readonly string[]) => [`urlcode ${kindNoun(kind)} add`, requested.join(' '), ...acks.flatMap(ack => ['--ack', ack])].join(' '));
              throw new ConfigError(`${name} refused: ${message}. If you accept that risk, re-run with the acknowledgement: ${retry([...acknowledgements, id].sort())}`);
            }
            throw new ConfigError(`${name} refused: ${message}`);
          }
        }
        assert(isRecord(scaffold) && isRecord(scaffold.config) && isRecord(scaffold.routes), `${name} scaffold must return config and routes objects`);
        assert((scaffold.acknowledged ?? []).every(id => acknowledgements.includes(id) && id.startsWith(`${name}:`)), `${name} scaffold may only acknowledge ${name}:<id> values the operator passed`);
        assert((scaffold.routeNotes ?? []).every(note => typeof note === 'string' && note.length <= 300 && !/[\r\n]/.test(note)), `${name} routeNotes must be single-line strings`);
        for (const route of Object.keys(scaffold.routes)) assert(!Object.hasOwn(loaded.routes, route) && !scaffolds.some(other => Object.hasOwn(other.result.routes, route)), `${name} adds route ${route}, which the project already has`);
        for (const file of scaffold.files ?? []) { if (file.content instanceof Uint8Array) secrets.push(file.content); scaffoldPath(site.site, file.path); }
        scaffolds.push({ name, result: scaffold });
      }
      const consumed = new Set(scaffolds.flatMap(item => item.result.acknowledged ?? []));
      const unused = acknowledgements.filter(id => !consumed.has(id));
      assert(!unused.length, `--ack ${unused.join(', ')} has no effect: no extension being added consumed it`);

      const doc = parseDocument(await readFile(yamlFile, 'utf8'));
      for (const { name, result: scaffold } of scaffolds) {
        doc.setIn(['extensions', name], { version: '1', config: scaffold.config });
        if (Object.keys(scaffold.routes).length) {
          const routesFile = `routes/${name}.yaml`, target = join(site.project, routesFile);
          const fragment = stringify({ version: '1', routes: scaffold.routes });
          validateDocument(parseYaml(fragment));
          const notes = (scaffold.routeNotes ?? []).map(note => `# ${note}\n`).join('');
          await writeExclusive(target, `# Routes for the ${name} extension (urlcode extensions remove ${name} deletes this file). Mounts are exclusive to it.\n${notes}${fragment}`, 0o644, site.site);
          state.created.push(target);
          if (doc.has('includes')) doc.addIn(['includes'], routesFile); else doc.set('includes', doc.createNode([routesFile]));
        }
        for (const file of scaffold.files ?? []) {
          const target = scaffoldPath(site.site, file.path);
          if (await exists(target)) { result.keptFiles.push(file.path); continue; }
          await writeExclusive(target, file.content, file.mode ?? 0o644, site.site);
          state.created.push(target);
        }
        for (const [key, text] of Object.entries(scaffold.env ?? {})) result.env[key] = text;
        result.notes.push(...(scaffold.notes ?? []));
      }
      validateDocument(doc.toJS());
      await writeFile(yamlFile, String(doc));
      let host = await readFile(site.hostFile, 'utf8');
      for (const { name } of scaffolds) host = hostWithExtension(host, name);
      await writeFile(site.hostFile, host);
      await loadDocument(site.project);
      result.projectSha256 = await inspectExtensionRevision(site.project);
    }
    result.added = toAdd;
    return result;
  } catch (error) { return rollBack(state, installing ? tree : undefined, site.site, error); }
  finally { for (const secret of secrets) secret.fill(0); }
}

export interface RemoveResult { removed: string; kept: string[]; projectSha256: string | undefined }
/** Where the project still uses extension `name`, outside the routes file its own add wrote. */
async function extensionUses(project: string, name: string): Promise<string[]> {
  const loaded = await loadDocument(project);
  let own: Record<string, unknown> = {};
  try { const raw = parseYaml(await readFile(join(project, 'routes', `${name}.yaml`), 'utf8')); if (isRecord(raw) && isRecord(raw.routes)) own = raw.routes; } catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
  const uses: string[] = [];
  for (const [pattern, route] of Object.entries(loaded.routes)) {
    if (Object.hasOwn(own, pattern)) continue;
    if ((route as { extension?: string }).extension === name || Object.hasOwn(effectiveExtensionPolicies(loaded.document, route), name)) uses.push(pattern);
  }
  if (isRecord(loaded.document.policies?.extensions) && Object.hasOwn(loaded.document.policies.extensions, name)) uses.push('policies.extensions (project level)');
  for (const [profile, value] of Object.entries(loaded.document.profiles ?? {})) if (isRecord(value?.extensions) && Object.hasOwn(value.extensions, name)) uses.push(`profiles.${profile}`);
  return uses;
}

/**
 * `urlcode extensions remove` / `urlcode artifacts remove`. Refuses while another installed add-on requires it or,
 * for an extension, while the project still uses it outside its own routes file. Data and operator files are never
 * deleted: the result lists them.
 */
export async function removeAddon(directory: string, kind: AddonKind, name: string, { manifest: given }: { manifest?: AddonManifest } = {}): Promise<RemoveResult> {
  const site = await openSite(directory), manifest = given ?? await readAddonManifest();
  const pin = manifest.addons[name];
  const pkg = await readJson<PackageJson>(site.packageFile);
  assert(pin && pin.kind === kind && Object.hasOwn(pkg.dependencies ?? {}, pin.package), `${name} is not an installed ${kind}`);
  const dependants = managedNames(manifest, pkg).filter(other => manifest.addons[other]!.requires.includes(name));
  assert(!dependants.length, `${dependants.join(', ')} require${dependants.length === 1 ? 's' : ''} ${name}; remove ${dependants.length === 1 ? 'it' : 'them'} first`);
  const yamlFile = join(site.project, 'urlcode.yaml'), routesFile = join(site.project, 'routes', `${name}.yaml`);
  const state = await snapshot([site.packageFile, join(site.site, 'package-lock.json'), yamlFile, site.hostFile, routesFile]);
  const tree = await dependencyTree(site.site);
  const kept: string[] = [];
  let installing = false;
  try {
    if (kind === 'extension') {
      const uses = await extensionUses(site.project, name);
      assert(!uses.length, `The project still uses ${name} in ${uses.join(', ')}; change those first`);
      const definition = await loadDefinition(site.site, name).catch(() => undefined);
      const doc = parseDocument(await readFile(yamlFile, 'utf8'));
      doc.deleteIn(['extensions', name]);
      if (isRecord(doc.toJS().extensions) && Object.keys(doc.toJS().extensions as object).length === 0) doc.delete('extensions');
      const includes = doc.get('includes') as { items?: { value?: unknown }[] } | undefined;
      const index = includes?.items?.findIndex(item => (isRecord(item) ? item.value : item) === `routes/${name}.yaml`) ?? -1;
      if (index >= 0) doc.deleteIn(['includes', index]);
      if (Array.isArray(doc.toJS().includes) && (doc.toJS().includes as unknown[]).length === 0) doc.delete('includes');
      await writeFile(yamlFile, String(doc));
      await rm(routesFile, { force: true });
      await writeFile(site.hostFile, hostWithoutExtension(await readFile(site.hostFile, 'utf8'), name));
      await loadDocument(site.project);
      if (definition?.scaffold) {
        // The files its scaffold would write are listed, never deleted; a scaffold that refuses without its acknowledgement lists none.
        const preview = await (async () => definition.scaffold!({ site: site.site, project: site.project, installed: managedNames(manifest, pkg, 'extension'), acknowledgements: [] }))().catch(() => undefined);
        for (const file of preview?.files ?? []) { if (file.content instanceof Uint8Array) file.content.fill(0); if (await exists(join(site.site, file.path))) kept.push(file.path); }
      }
    }
    delete pkg.dependencies![pin.package];
    await writeFile(site.packageFile, renderJson(pkg));
    installing = true;
    await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], site.site);
    return { removed: name, kept, projectSha256: kind === 'extension' ? await inspectExtensionRevision(site.project) : undefined };
  } catch (error) { return rollBack(state, installing ? tree : undefined, site.site, error); }
}

export interface ListedAddon { name: string; kind: AddonKind; package: string; version: string | null; pinned: boolean; declared: boolean; hosted: boolean; description: string; requires: string[]; descriptor?: AddonDescriptor | undefined; problems: string[] }
export interface AddonReport { site: string; core: string; development: boolean; addons: ListedAddon[]; unmanaged: string[]; problems: string[] }
/** `urlcode extensions list` / `urlcode artifacts list`: what is installed, whether each matches core's pin, and any drift. */
export async function listAddons(directory: string, kind: AddonKind, { manifest: given }: { manifest?: AddonManifest } = {}): Promise<AddonReport> {
  const site = await openSite(directory), manifest = given ?? await readAddonManifest();
  const pkg = await readJson<PackageJson>(site.packageFile), lock = await lockPackages(site.site);
  const host = await readFile(site.hostFile, 'utf8'), loaded = await loadDocument(site.project);
  const declared = loaded.document.extensions ?? {};
  const report: AddonReport = { site: site.site, core: manifest.version, development: isDevelopmentManifest(manifest), addons: [], unmanaged: [], problems: [] };
  const knownPackages = new Set(Object.values(manifest.addons).map(pin => pin.package));
  report.unmanaged = Object.keys(pkg.dependencies ?? {}).filter(name => name.startsWith('@jimhoyd/urlcode-') && !knownPackages.has(name)).sort();
  for (const name of managedNames(manifest, pkg, kind)) {
    const pin = manifest.addons[name]!, problems: string[] = [];
    if (pkg.dependencies?.[pin.package] !== pin.url) problems.push(`package.json points ${pin.package} at ${pkg.dependencies?.[pin.package]}, not core's pin ${pin.url}`);
    const pinned = pinProblem(lock, pin);
    if (pinned) problems.push(pinned);
    const descriptor = await readInstalledDescriptor(site.site, name).catch(error => { problems.push(error instanceof Error ? error.message : String(error)); return undefined; });
    if (!descriptor) problems.push(`${pin.package} is not installed; run npm ci`);
    const isDeclared = Object.hasOwn(declared, name), hosted = host.split('\n').includes(importLine(name));
    if (kind === 'extension') {
      if (!isDeclared) problems.push(`${PROJECT_DIRECTORY}/urlcode.yaml does not declare extensions.${name}`);
      if (!hosted) problems.push(`${HOST_FILE} does not import ${addonPackage(name)}/extension`);
    } else if (descriptor) {
      const lockProblem = artifactLockProblem(lock, pin);
      if (lockProblem) problems.push(lockProblem);
      await assertInertArtifact(join(site.site, 'node_modules', pin.package), name).catch(error => problems.push(error instanceof Error ? error.message : String(error)));
    }
    for (const requirement of pin.requires) if (!Object.hasOwn(pkg.dependencies ?? {}, manifest.addons[requirement]!.package)) problems.push(`requires ${requirement}, which is not installed`);
    report.addons.push({ name, kind, package: pin.package, version: lock[`node_modules/${pin.package}`]?.version ?? null, pinned: pinned === undefined, declared: isDeclared, hosted, description: pin.description, requires: pin.requires, descriptor, problems });
    report.problems.push(...problems.map(problem => `${name}: ${problem}`));
  }
  if (kind === 'extension') {
    for (const name of Object.keys(declared)) if (!report.addons.some(item => item.name === name)) report.problems.push(`${PROJECT_DIRECTORY}/urlcode.yaml declares extensions.${name}, but no installed extension provides it${host.includes(name) ? ' (it may be wired by hand in host.mjs)' : ''}`);
    for (const nested of nestedCopies(lock)) report.problems.push(`nested copy ${nested}: every add-on must resolve once, at the top level`);
  }
  return report;
}

/**
 * Static validation of declared extensions without running any extension code: each `extensions.<name>.config`
 * and each route's `policies.extensions.<name>` requirement is checked against the installed package's
 * `urlcode.json` schemas. Used by `validate` when no host file is loaded. Returns problems; an extension whose
 * package is not installed in the enclosing site is reported, not guessed.
 */
export async function validateDeclaredExtensions(project: string): Promise<string[]> {
  const loaded = await loadDocument(project), declared = loaded.document.extensions ?? {};
  if (!Object.keys(declared).length) return [];
  const site = dirname(loaded.root), problems: string[] = [];
  const ajv = new Ajv.default({ strict: false, allErrors: true });
  const policyValidators = new Map<string, ReturnType<typeof ajv.compile> | undefined>();
  for (const [name, declaration] of Object.entries(declared)) {
    const descriptor = await readInstalledDescriptor(site, name).catch(() => undefined);
    if (!descriptor || descriptor.kind !== 'extension' || !descriptor.schema) { problems.push(`extensions.${name}: ${addonPackage(name)} is not installed in ${site}; run \`urlcode extensions add ${name}\` or npm ci`); continue; }
    const validate = ajv.compile(descriptor.schema);
    if (!validate(declaration.config)) problems.push(`extensions.${name}.config: ${ajv.errorsText(validate.errors)}`);
    policyValidators.set(name, descriptor.policySchema ? ajv.compile(descriptor.policySchema) : undefined);
  }
  for (const [pattern, route] of Object.entries(loaded.routes)) for (const [name, requirement] of Object.entries(effectiveExtensionPolicies(loaded.document, route))) {
    if (!policyValidators.has(name)) continue;
    const validate = policyValidators.get(name);
    if (!validate) { if (Object.keys(requirement).length) problems.push(`${pattern}: ${name} takes no route requirement`); continue; }
    if (!validate(requirement)) problems.push(`${pattern}: policies.extensions.${name}: ${ajv.errorsText(validate.errors)}`);
  }
  return problems;
}

export interface InstalledArtifact { name: string; version: string | null; status: 'installed' | 'unpinned' | 'invalid'; problem?: string; files: string[] }
/** Agent references from installed, core-pinned add-ons. Static descriptors only: this never imports an extension. */
export async function describeInstalledAgentTooling(project: string): Promise<{ site: string; addons: { name: string; kind: AddonKind; version: string | null; agent: NonNullable<AddonDescriptor['agent']> }[] }> {
  const site = dirname(resolve(project));
  const reports = await Promise.all((['extension', 'artifact'] as const).map(kind => listAddons(site, kind).catch(() => undefined)));
  const addons = reports.flatMap(report => report?.addons ?? []).flatMap(addon =>
    addon.pinned && addon.problems.length === 0 && addon.descriptor?.agent
      ? [{name: addon.name, kind: addon.kind, version: addon.version, agent: structuredClone(addon.descriptor.agent)}]
      : []);
  return {site, addons};
}
/**
 * The artifacts installed in the site around `project` (its parent directory), for MCP and planning. Read-only and
 * offline: it checks each one is inert and matches core's pin, and never imports or runs anything.
 */
export async function describeInstalledArtifacts(project: string, { manifest: given }: { manifest?: AddonManifest } = {}): Promise<{ site: string; artifacts: InstalledArtifact[] }> {
  const site = dirname(resolve(project));
  let pkg: PackageJson;
  try { pkg = await readJson<PackageJson>(join(site, 'package.json')); } catch (error) { if (isCode(error, 'ENOENT')) return { site, artifacts: [] }; throw error; }
  const manifest = given ?? await readAddonManifest().catch(() => undefined), lock = await lockPackages(site);
  const artifacts: InstalledArtifact[] = [];
  for (const dependency of Object.keys(pkg.dependencies ?? {}).filter(name => name.startsWith('@jimhoyd/urlcode-')).sort()) {
    const name = dependency.slice('@jimhoyd/urlcode-'.length), directory = join(site, 'node_modules', dependency);
    const descriptor = await readInstalledDescriptor(site, name).catch(() => undefined);
    if (descriptor?.kind !== 'artifact') continue;
    const item: InstalledArtifact = { name, version: lock[`node_modules/${dependency}`]?.version ?? null, status: 'installed', files: [] };
    try {
      await assertInertArtifact(directory, name);
      const pin = manifest?.addons[name];
      const problem = pin ? pinProblem(lock, pin) : 'this core does not pin it';
      if (problem) { item.status = 'unpinned'; item.problem = problem; }
      const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else item.files.push(relative(await realpath(directory), await realpath(path)).split(sep).join('/')); } };
      await walk(await realpath(directory));
      item.files.sort();
    } catch (error) { item.status = 'invalid'; item.problem = error instanceof Error ? error.message : String(error); }
    artifacts.push(item);
  }
  return { site, artifacts };
}
/** One bounded JSON or Markdown member of an installed, inert, pinned artifact. */
export async function readArtifactMember(project: string, name: string, path: string, options: { manifest?: AddonManifest } = {}): Promise<{ name: string; path: string; content: unknown }> {
  assert(addonNamePattern.test(name) && /^(?:README\.md|urlcode\.json|(?:schemas|config)\/[A-Za-z0-9._-]+\.json)$/.test(path), 'Name an installed artifact and one of its README.md, urlcode.json, schemas/*.json or config/*.json files');
  const { site, artifacts } = await describeInstalledArtifacts(project, options);
  const artifact = artifacts.find(item => item.name === name);
  assert(artifact, `${name} is not an installed artifact in ${site}`);
  assert(artifact.status === 'installed', `${name} is ${artifact.status}: ${artifact.problem ?? ''}`);
  assert(artifact.files.includes(path), `${name} has no ${path}`);
  const text = await readFile(join(site, 'node_modules', addonPackage(name), path), 'utf8');
  return { name, path, content: path.endsWith('.json') ? JSON.parse(text) : text };
}
