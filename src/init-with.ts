import { mkdir, open, readFile, rm, unlink, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { initProject } from './authoring.ts';
import { mcpConfigFile, renderMcpConfig } from './agents-guide.ts';
import { loadDocument, parseYaml, validateDocument } from './config.ts';
import { inspectExtensionRevision } from './extensions.ts';
import type { ScaffoldRequest, ScaffoldResult } from './extensions.ts';
import { collectDependencySet, installSteps, renderPackageManifest } from './project-dependencies.ts';
import type { DependencyPin, DependencySet } from './project-dependencies.ts';
import { ConfigError, assert } from './errors.ts';

/** Directory names inside the generated site. The route project lives under `app/`; everything else is operator-owned. */
const PROJECT_DIRECTORY = 'app', HOST_FILE = 'host.mjs', ROUTES_FILE = 'routes/extensions.yaml';
const namePattern = /^[a-z][a-z0-9-]{0,63}$/, capabilityPattern = /^[a-z][a-z0-9.:-]{0,63}$/;
export interface InitWithOptions {
  cwd?: string | undefined;
  /** Default true: record exact pins for core, the named extensions and their declared peers. */
  manifest?: boolean | undefined;
  /** `--pin <package>=<specifier>` overrides, for local tarballs, checkouts and mirrors. */
  pins?: ReadonlyMap<string, string> | undefined;
}
export interface InitWithResult { directory: string; project: string; hostFile: string; extensions: string[]; projectSha256: string; nextSteps: string[]; dependencies: DependencyPin[] }

export function parseWithNames(value: string): string[] {
  const names = value.split(',').map(name => name.trim());
  assert(names.length > 0 && names.every(name => namePattern.test(name)), 'Use --with name[,name] where each name is a lowercase extension package suffix such as auth');
  assert(new Set(names).size === names.length, 'Duplicate --with names');
  return names;
}
const packageName = (name: string): string => `@jimhoyd/urlcode-${name}`;
const isCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Orders the requested set from the scaffolds' declared `requires`, `after`, `provides` and `conflicts`, never from
 * the `--with` spelling. Kahn's algorithm with the lexically smallest ready extension first, so the result is
 * deterministic and identical for every permutation. Refuses a missing requirement, a conflict or a cycle by name.
 */
export function orderScaffolds(results: readonly ScaffoldResult[]): ScaffoldResult[] {
  const byName = new Map<string, ScaffoldResult>(), providers = new Map<string, string>();
  for (const result of results) byName.set(result.name, result);
  for (const result of results) for (const capability of result.provides ?? []) {
    assert(!byName.has(capability) || capability === result.name, `${result.name} provides ${capability}, which is also an extension name`);
    assert(!providers.has(capability) || providers.get(capability) === result.name, `Capability ${capability} is provided by both ${providers.get(capability)} and ${result.name}`);
    providers.set(capability, result.name);
  }
  const locate = (dependency: string): string | undefined => byName.has(dependency) ? dependency : providers.get(dependency);
  const edges = new Map<string, Set<string>>(results.map(result => [result.name, new Set<string>()]));
  for (const result of results) {
    for (const other of result.conflicts ?? []) { const target = locate(other); assert(target === undefined || target === result.name, `${result.name} conflicts with ${target}; remove one from --with`); }
    for (const dependency of result.requires ?? []) {
      const target = locate(dependency);
      assert(target !== undefined, `${result.name} requires ${dependency}${byName.has(dependency) ? '' : ', which is not part of this composition; add the extension that provides it to --with'}`);
      if (target !== result.name) edges.get(result.name)!.add(target);
    }
    for (const dependency of result.after ?? []) { const target = locate(dependency); if (target !== undefined && target !== result.name) edges.get(result.name)!.add(target); }
  }
  const ordered: ScaffoldResult[] = [], placed = new Set<string>();
  while (ordered.length < results.length) {
    const ready = [...byName.keys()].filter(name => !placed.has(name) && [...edges.get(name)!].every(dependency => placed.has(dependency))).sort();
    if (ready.length === 0) {
      const stuck = [...byName.keys()].filter(name => !placed.has(name)).sort();
      throw new ConfigError(`Extension ordering has a cycle among ${stuck.map(name => `${name} (needs ${[...edges.get(name)!].filter(dependency => !placed.has(dependency)).sort().join(', ')})`).join('; ')}`);
    }
    placed.add(ready[0]!); ordered.push(byName.get(ready[0]!)!);
  }
  return ordered;
}

/**
 * Resolves the extension package from the invoking directory (Node's package resolution with the default
 * conditions), imports it, and calls its `scaffold` export. Nothing is bundled; core never imports these packages
 * at build time. Refuses a missing package or a package without `scaffold` before anything is written.
 */
async function loadScaffold(name: string, request: ScaffoldRequest, cwd: string): Promise<ScaffoldResult> {
  const pkg = packageName(name);
  let entry: string;
  try { entry = createRequire(join(cwd, 'package.json')).resolve(pkg); }
  catch (error) {
    if (isCode(error, 'MODULE_NOT_FOUND')) throw new ConfigError(`Extension package ${pkg} is not installed in ${cwd}; run: npm install ${pkg}`);
    throw error;
  }
  const module = await import(pathToFileURL(entry).href) as Record<string, unknown>;
  const scaffold = module.scaffold;
  if (typeof scaffold !== 'function') throw new ConfigError(`${pkg} does not export scaffold; upgrade it to a release that supports urlcode init --with, or add ${name} by hand following its README`);
  let result: unknown;
  try { result = await (scaffold as (request: ScaffoldRequest) => unknown)(request); }
  catch (error) { throw new ConfigError(`${pkg} scaffold refused: ${error instanceof Error ? error.message : String(error)}`); }
  assert(record(result) && result.name === name, `${pkg} scaffold must return a result named ${name}`);
  assert(record(result.extensions) && record(result.routes), `${pkg} scaffold must return extensions and routes objects`);
  assert(strings(result.hostImports) && strings(result.hostSetup) && strings(result.hostEntries) && (result.hostClose === undefined || strings(result.hostClose)), `${pkg} scaffold must return host fragments as string arrays`);
  assert(strings(result.nextSteps) && typeof result.readme === 'string', `${pkg} scaffold must return readme text and nextSteps strings`);
  for (const key of ['provides', 'requires', 'after', 'conflicts'] as const) assert(result[key] === undefined || (strings(result[key]) && (result[key] as string[]).every(item => capabilityPattern.test(item))), `${pkg} scaffold ${key} must list extension names or capability names`);
  assert(result.env === undefined || (record(result.env) && Object.values(result.env).every(item => typeof item === 'string')), `${pkg} scaffold env must map names to descriptions`);
  assert(Array.isArray(result.files) && result.files.every((file: unknown) => record(file) && typeof file.path === 'string' && (typeof file.content === 'string' || file.content instanceof Uint8Array) && (file.mode === undefined || (Number.isInteger(file.mode) && (file.mode as number) >= 0 && (file.mode as number) <= 0o777))), `${pkg} scaffold files must carry a path, content and an optional mode`);
  return result as unknown as ScaffoldResult;
}

function filePath(root: string, path: string): string {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.includes('\0'), 'Invalid scaffold file path');
  const target = resolve(root, path), rel = relative(root, target);
  assert(!path.startsWith('/') && rel === path.split('/').join(sep) && rel.length > 0 && !rel.startsWith('..'), `Scaffold file path must stay inside the site directory: ${path}`);
  assert(rel !== PROJECT_DIRECTORY && !rel.startsWith(PROJECT_DIRECTORY + sep), `Scaffold files must stay outside the route project: ${path}`);
  return target;
}
/** Creates the file exclusively: nothing generated is ever overwritten. */
async function write(target: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const file = await open(target, 'wx', mode);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
function renderHost(names: readonly string[], results: readonly ScaffoldResult[]): string {
  const lines = [`// Generated by urlcode init --with ${names.join(',')}. Trusted operator code: keep it outside ${PROJECT_DIRECTORY}/ and review before serving.`];
  // Extensions that need the same module (node:url, for example) each list it; an identical line is written once so the host stays valid ESM.
  for (const result of results) for (const line of result.hostImports) if (!lines.includes(line)) lines.push(line);
  lines.push('');
  for (const result of results) if (result.hostSetup.length) lines.push(...result.hostSetup);
  lines.push('export default {', '  extensions: [');
  for (const result of results) for (const entry of result.hostEntries) lines.push(`    ${entry},`);
  lines.push('  ],', '  async close() {');
  // Later extensions may depend on earlier setup, so release in reverse order.
  for (const result of [...results].reverse()) for (const statement of result.hostClose ?? []) lines.push(`    ${statement}`);
  lines.push('  },', '};');
  return lines.join('\n') + '\n';
}
function demote(markdown: string): string {
  let fence = false;
  return markdown.split('\n').map(line => { if (/^\s*(?:```|~~~)/.test(line)) fence = !fence; return !fence && /^#{1,5} /.test(line) ? `#${line}` : line; }).join('\n');
}
function renderDependencySection(directory: string, set: DependencySet): string {
  const rows = set.pins.map(pin => `- \`${pin.name}\` ${pin.version} (${pin.role})${pin.specifier === pin.version ? '' : ` installed from \`${pin.specifier}\``}`);
  const lines = ['## Dependencies', '',
    '`package.json` pins the runtime, every extension named in `--with` and their declared peers to the exact versions that were installed when this site was generated. Those versions were checked against each package\'s own `peerDependencies` as one set.', '',
    ...rows, '',
    ...installSteps(directory, set).flatMap(step => [step, '']),
    set.local ? 'At least one pin is a local path or tarball rather than a registry version: reproducing this install needs that path to exist, so keep it under your control or replace the specifier before publishing the site.' : 'The pins are registry versions; `npm install` resolves them without the network only if your cache or mirror already holds them.', '',
    'There is no upgrade command. Changing a pinned version today means editing `package.json` yourself and re-running `npm install`; review the extension changelogs first.', ''];
  return lines.join('\n');
}
function renderReadme(directory: string, names: readonly string[], results: readonly ScaffoldResult[], starter: string, env: Record<string, string>, projectSha256: string, set?: DependencySet | undefined): string {
  const steps = [...(set ? installSteps(directory, set) : []), ...results.flatMap(result => result.nextSteps)];
  const parts = [`# ${basename(directory)}`, '',
    `Created with \`urlcode init ${basename(directory)} --with ${names.join(',')}\`. \`${PROJECT_DIRECTORY}/\` is the route project (\`urlcode.yaml\`, functions, tests); \`${HOST_FILE}\` is the trusted operator host that wires the installed extension packages; operator modules and private data stay outside the project. Run every command with \`--project ${PROJECT_DIRECTORY} --host-file "$PWD/${HOST_FILE}"\`.`, '',
    '## Starter', '', `The starter files live in \`${PROJECT_DIRECTORY}/\`; add \`--project ${PROJECT_DIRECTORY}\` and the host file to the commands below.`, '', demote(starter).trim(), ''];
  for (const result of results) parts.push(`## Extension: ${result.name}`, '', result.readme.trim(), '');
  if (set) parts.push(renderDependencySection(directory, set));
  parts.push('## Next steps', '', ...steps.map((step, index) => `${index + 1}. ${step}`), '');
  if (Object.keys(env).length) parts.push('## Environment', '', ...Object.entries(env).map(([key, text]) => `- \`${key}\`: ${text}`), '');
  parts.push('## Project revision', '', `\`${PROJECT_DIRECTORY}/urlcode.yaml\` currently has revision \`${projectSha256}\` (\`inspectExtensionRevision\`). Review the project, then pin exactly that value where the host expects it; any change to extension YAML, policies or mounts changes it and needs a new explicit review.`, '');
  return parts.join('\n');
}

/**
 * `urlcode init <directory> --with a,b`: the starter under `app/`, every extension's fragments merged into one
 * `urlcode.yaml`, one `host.mjs`, one `README.md` and the extensions' own files. All packages are resolved and
 * their scaffolds computed before anything is written, so a refusal leaves no directory behind.
 */
export async function initProjectWith(destination: string, requested: readonly string[], { cwd = process.cwd(), manifest = true, pins }: InitWithOptions = {}): Promise<InitWithResult> {
  assert(requested.length > 0, 'Provide at least one --with name');
  assert(new Set(requested).size === requested.length, 'Duplicate --with names');
  // --with is an unordered set: scaffolds see one canonical name order, and the emitted order comes from their declared requirements.
  const sorted = [...requested].sort();
  const directory = resolve(destination), project = join(directory, PROJECT_DIRECTORY), hostFile = join(directory, HOST_FILE);
  const request: ScaffoldRequest = { directory, project, hostFile, names: sorted };
  const results: ScaffoldResult[] = [];
  const wipe = (): void => { for (const result of results) for (const file of result.files) if (file.content instanceof Uint8Array) file.content.fill(0); };
  try {
    for (const name of sorted) results.push(await loadScaffold(name, request, cwd));
    results.splice(0, results.length, ...orderScaffolds(results));
    const names = results.map(result => result.name);
    // Cross-result conflicts are refused before the destination exists.
    const extensions: Record<string, unknown> = Object.create(null) as Record<string, unknown>, routes: Record<string, unknown> = Object.create(null) as Record<string, unknown>, env: Record<string, string> = {};
    const owners = new Map<string, string>();
    for (const result of results) {
      for (const [key, value] of Object.entries(result.extensions)) { assert(!Object.hasOwn(extensions, key), `Extension ${key} is declared by both ${owners.get('e:' + key)} and ${result.name}`); owners.set('e:' + key, result.name); extensions[key] = value; }
      for (const [key, value] of Object.entries(result.routes)) { assert(!Object.hasOwn(routes, key), `Route ${key} is added by both ${owners.get('r:' + key)} and ${result.name}`); owners.set('r:' + key, result.name); routes[key] = value; }
      for (const [key, value] of Object.entries(result.env ?? {})) { assert(!Object.hasOwn(env, key) || env[key] === value, `Environment variable ${key} is described differently by ${result.name}`); env[key] = value; }
      const seen = new Set<string>();
      for (const file of result.files) { const path = filePath(directory, file.path); assert(!seen.has(path), `${result.name} scaffolds ${file.path} twice`); seen.add(path); }
    }
    // Also resolved before the destination exists: an incompatible or incompletely installed set refuses with
    // nothing written. It runs after the scaffold conflicts so a composition error is still reported as one.
    const dependencies = manifest ? await collectDependencySet(names, names.map(packageName), { cwd, ...(pins === undefined ? {} : { overrides: pins }) }) : undefined;
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { mode: 0o700 }); // refuses an existing destination
    try {
      await initProject(project);
      const starter = await readFile(join(project, 'README.md'), 'utf8');
      await unlink(join(project, 'README.md')); // its content moves into the site README
      await unlink(join(project, mcpConfigFile)); // re-registered at the site root, pointing at app/
      // Refuse routes or extensions the starter already declares, including in its included files.
      const loaded = await loadDocument(project);
      for (const key of Object.keys(routes)) assert(!Object.hasOwn(loaded.routes, key), `Route ${key} from ${owners.get('r:' + key)} already exists in the starter`);
      for (const key of Object.keys(extensions)) assert(!Object.hasOwn(loaded.document.extensions ?? {}, key), `Extension ${key} from ${owners.get('e:' + key)} already exists in the starter`);
      const yamlFile = join(project, 'urlcode.yaml'), original = await readFile(yamlFile, 'utf8');
      const doc = parseDocument(original);
      // Extensions are declared in the entry file; their routes go into a last include so the starter's own routes
      // stay first in the loaded order and the entry file stays small.
      doc.set('extensions', { ...loaded.document.extensions, ...extensions });
      doc.addIn(['includes'], ROUTES_FILE);
      const fragment = stringify({ version: '1', routes });
      validateDocument(doc.toJS()); validateDocument(parseYaml(fragment));
      await write(join(project, ROUTES_FILE), `# Routes added by urlcode init --with ${names.join(',')}. Mounts are exclusive to the named extension.\n${fragment}`);
      await rm(yamlFile); await write(yamlFile, String(doc));
      await loadDocument(project);
      const projectSha256 = await inspectExtensionRevision(project);
      const written = new Set<string>();
      for (const result of results) for (const file of result.files) {
        const target = filePath(directory, file.path);
        assert(!written.has(target), `Scaffold file ${file.path} is written by more than one extension`);
        // Parent directories are created; existing files or symlinks anywhere on the path are refused.
        let probe = dirname(target);
        while (probe !== directory && probe.startsWith(directory)) { try { assert(!(await lstat(probe)).isSymbolicLink(), `Scaffold path passes through a symlink: ${file.path}`); } catch (error) { if (!isCode(error, 'ENOENT')) throw error; } probe = dirname(probe); }
        await write(target, file.content, file.mode ?? 0o644); written.add(target);
      }
      await write(hostFile, renderHost(names, results), 0o600);
      if (dependencies) await write(join(directory, 'package.json'), renderPackageManifest(directory, dependencies));
      await write(join(directory, 'README.md'), renderReadme(directory, names, results, starter, env, projectSha256, dependencies));
      await write(join(directory, '.gitignore'), 'node_modules/\ndata/\n.env\n.env.*\n');
      // The read-only MCP server for agents opened at the site root; --host-file and --allow-authoring stay operator choices.
      await write(join(directory, mcpConfigFile), renderMcpConfig(PROJECT_DIRECTORY));
      // AGENTS.md: initProject writes the application-level file into app/ once it produces one (NEXT-STEPS 1.1);
      // nothing here overrides it. A site-level agent note would be assembled beside README.md at this point.
      return { directory, project, hostFile, extensions: [...names], projectSha256,
        nextSteps: [...(dependencies ? installSteps(directory, dependencies) : []), ...results.flatMap(result => result.nextSteps)],
        dependencies: dependencies?.pins ?? [] };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  } finally { wipe(); }
}
