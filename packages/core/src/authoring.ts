import { readdir, mkdir, mkdtemp, rename, rm, readFile, writeFile, open, lstat, stat } from 'node:fs/promises';
import { basename, resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseDocument } from 'yaml';
import { loadDocument, validateDocument } from './config.ts';
import { renderAgentsGuide, renderMcpConfig, mcpConfigFile } from './agents-guide.ts';
import { compileRoutes } from './router.ts';
import { prepareFunctionSnapshot, requestedPermissions } from './policy.ts';
import { assert } from './errors.ts';
import type { LoadedDocument } from './types.ts';
import { projectScripts } from './context.ts';
import { runningCoreVersion } from './version.ts';
import { HOST_FILE, PROJECT_DIRECTORY, renderInitialHost } from './addon-install.ts';
import { enclosingProject, isFile } from './site-layout.ts';

/**
 * Points the copied starter's version-bearing references at the release of the runtime running init: the
 * editor `$schema` URL and the CI action ref. The committed starter carries the same values for clones (release
 * preparation bumps them), so this matters for a checkout between releases, but a fresh site must never name
 * a schema or action older than the runtime that wrote it.
 */
export function stampStarterText(text: string, version: string): string {
  return text
    .replace(/(https:\/\/raw\.githubusercontent\.com\/jimhoyd-com\/urlcode\/)[^/\s]+(\/schemas\/urlcode\.schema\.json)/g, `$1v${version}$2`)
    .replace(/(jimhoyd-com\/urlcode\/action@)[^\s#]+/g, `$1v${version}`);
}
const stampedStarterFiles = [`${PROJECT_DIRECTORY}/urlcode.yaml`, '.github/workflows/urlcode.yml'];
// `npm init -y` writes this placeholder; replacing it is the only change init makes to an existing script.
const npmPlaceholderTest = 'echo "Error: no test specified" && exit 1';
const TRIMMED = '._-';
/** A valid npm package name from the directory name. Trimmed with indices, not an anchored regex (CodeQL js/polynomial-redos). */
function packageName(directory: string): string {
  const mapped = (directory.split(/[\\/]/).pop() ?? 'urlcode-site').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  let start = 0, end = mapped.length;
  while (start < end && TRIMMED.includes(mapped[start] ?? '')) start += 1;
  while (end > start && TRIMMED.includes(mapped[end - 1] ?? '')) end -= 1;
  return mapped.slice(start, end).slice(0, 214) || 'urlcode-site';
}
/**
 * The site's package.json: an exact runtime pin and the npm scripts that run it. An existing manifest (from
 * `npm init` and `npm install @jimhoyd/urlcode`) keeps every key and script; only a missing runtime pin and missing
 * scripts are added.
 */
function sitePackageJson(existing: string | undefined, directory: string, version: string, routes: number): string {
  const manifest = existing === undefined ? { name: packageName(directory), private: true, version: '0.0.0', type: 'module' } as Record<string, unknown> : JSON.parse(existing) as Record<string, unknown>;
  const scripts = { ...(manifest.scripts as Record<string, string> | undefined) };
  for (const [name, command] of Object.entries(projectScripts(routes))) if (scripts[name] === undefined || (name === 'test' && scripts[name] === npmPlaceholderTest)) scripts[name] = command;
  const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) };
  const dev = manifest.devDependencies as Record<string, string> | undefined;
  if (dependencies['@jimhoyd/urlcode'] === undefined && dev?.['@jimhoyd/urlcode'] === undefined) dependencies['@jimhoyd/urlcode'] = version;
  const indent = existing === undefined ? 2 : /^\{\r?\n([ \t]+)"/.exec(existing)?.[1] ?? 2;
  return JSON.stringify({ ...manifest, scripts, dependencies }, null, indent) + '\n';
}

// Agents install the runtime before they can read its docs, so `init .` has to work after `npm init` and `npm install`.
// A directory holding nothing but what npm and git create, plus a pre-registered `.mcp.json` (see below), is initialized
// in place: its package.json gains the runtime pin and missing scripts. Anything else is user work: init refuses it
// unless the caller passes --adopt, and then writes only new files beside it and never changes an existing one.
const inPlaceEntries = new Set(['package.json', 'package-lock.json', 'node_modules', '.git', mcpConfigFile]);
/** At most this many paths in a refusal or a left-alone report; the rest are counted. */
export const initListLimit = 20;
export function boundedList(paths: readonly string[], limit = initListLimit): string {
  return paths.length <= limit ? paths.join(', ') : `${paths.slice(0, limit).join(', ')} and ${paths.length - limit} more`;
}
export interface InitOptions {
  /**
   * `--adopt`: create the site around user files already in the destination. Refused when anything there collides
   * with what init writes; otherwise only new files are written and every existing entry is left exactly as it is.
   */
  adopt?: boolean | undefined;
  /** npm runs after init (`init --with`), so node_modules and package-lock.json are part of what an adopting init writes. */
  installs?: boolean | undefined;
}
interface PlannedFile { path: string; source?: string; mode: number }
export interface InitPlan {
  /** The absolute destination. */
  target: string;
  /** `new` (nothing there), `in-place` (only npm/git entries) or `adopt` (user entries, which need --adopt). */
  mode: 'new' | 'in-place' | 'adopt';
  /** Top-level names in the destination before init, sorted. */
  existing: string[];
  /** Top-level names other than those npm and git create. */
  foreign: string[];
  /** Destination-relative POSIX paths an adopting init would have to write or write into, sorted. */
  collisions: string[];
  /** Why init refuses this destination with these options; undefined when it would proceed. */
  refusal: string | undefined;
}
const starterDirectory = (): string => fileURLToPath(new URL('../../../starters/default/', import.meta.url));
/** The starter's files as site-relative POSIX paths: every file init copies, in a stable order. */
async function starterFiles(): Promise<PlannedFile[]> {
  const files: PlannedFile[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!prefix && (entry.name === '.gitignore' || entry.name === 'AGENTS.md' || entry.name === mcpConfigFile)) continue;
      const source = join(directory, entry.name), path = prefix + (!prefix && entry.name === 'gitignore.template' ? '.gitignore' : entry.name);
      if (entry.isDirectory()) await walk(source, `${path}/`);
      else files.push({ path, source, mode: (await stat(source)).mode & 0o777 });
    }
  };
  await walk(starterDirectory(), '');
  return files;
}
const lstatOrUndefined = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
/**
 * What an adopting init would collide with: an existing path it writes, an existing non-directory (a file or a
 * symlink, which is never followed) where it needs a directory, and anything at all at a path it owns whole.
 */
async function findCollisions(target: string, files: readonly string[], whole: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const path of whole) if (await lstatOrUndefined(join(target, path))) found.add(path);
  for (const path of files) {
    if (whole.some(owned => path === owned || path.startsWith(`${owned}/`))) continue;
    const segments = path.split('/');
    let clear = true;
    for (let index = 1; index < segments.length && clear; index += 1) {
      const directory = segments.slice(0, index).join('/'), info = await lstatOrUndefined(join(target, ...segments.slice(0, index)));
      if (!info) { clear = false; break; }
      if (!info.isDirectory()) { found.add(directory); clear = false; }
    }
    if (clear && await lstatOrUndefined(join(target, ...segments))) found.add(path);
  }
  return [...found].sort();
}
/**
 * Read-only: what `urlcode init` would do at a destination with these options, and why it would refuse. Writes
 * nothing; `bootstrap` uses it to name the exact next command.
 */
export async function planInit(destination: string, options: InitOptions = {}): Promise<InitPlan & { files: PlannedFile[] }> {
  const target = resolve(destination);
  let names: string[] | undefined;
  try { names = (await readdir(target)).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const existing = names ?? [], foreign = existing.filter(name => !inPlaceEntries.has(name));
  const mode = names === undefined ? 'new' : foreign.length ? 'adopt' : 'in-place';
  const files = await starterFiles();
  files.push({ path: HOST_FILE, mode: 0o600 }, { path: 'AGENTS.md', mode: 0o644 });
  // .mcp.json registers the read-only server for repository-aware agents. A file already there (for example
  // `urlcode mcp print-config` run before the agent's session started) is kept exactly as written.
  if (!existing.includes(mcpConfigFile)) files.push({ path: mcpConfigFile, mode: 0o644 });
  // In place, npm's package.json gains the pin and scripts; adopting, it would be an existing file init changes.
  if (mode !== 'in-place' || !existing.includes('package.json')) files.push({ path: 'package.json', mode: 0o644 });
  const collisions = mode === 'adopt' ? await findCollisions(target, files.map(file => file.path), [PROJECT_DIRECTORY, ...(options.installs ? ['node_modules', 'package-lock.json'] : [])]) : [];
  const site = mode !== 'adopt' ? undefined : await isFile(join(target, PROJECT_DIRECTORY, 'urlcode.yaml')) ? `${PROJECT_DIRECTORY}/urlcode.yaml` : await isFile(join(target, 'urlcode.yaml')) ? 'urlcode.yaml' : undefined;
  const enclosing = options.adopt ? await enclosingProject(target) : undefined;
  let refusal: string | undefined;
  if (site !== undefined) refusal = `Directory already holds a URLCode site (${site}); init writes nothing into an existing site. Run urlcode bootstrap on it instead`;
  else if (mode === 'adopt' && !options.adopt) refusal = `Directory already contains ${boundedList(foreign, 5)}; ${collisions.length
    ? `init into a new or empty directory, or one holding only package.json, package-lock.json, node_modules or .git. --adopt would not help here: init writes ${boundedList(collisions)}, which ${collisions.length === 1 ? 'is' : 'are'} already there`
    : 'nothing there collides with what init writes, so add --adopt to create the site around it (init then writes only new files and leaves every existing entry as it is), or init into a new or empty directory'}`;
  else if (options.adopt && basename(target) === PROJECT_DIRECTORY) refusal = `A site keeps its route project in ${PROJECT_DIRECTORY}/, so adopting an ${PROJECT_DIRECTORY} directory nests ${PROJECT_DIRECTORY}/${PROJECT_DIRECTORY}; name its parent instead`;
  else if (enclosing !== undefined) refusal = `The destination is inside an existing URLCode project (${enclosing}); init --adopt does not create a site inside another`;
  else if (collisions.length) refusal = `init --adopt refuses ${boundedList(collisions)}: init writes ${collisions.length === 1 ? 'that path, and it is' : 'those paths, and they are'} already in the directory (init never overwrites, never writes into an existing app/ and never follows a symlink). Nothing was changed; move ${collisions.length === 1 ? 'it' : 'them'} aside or init into a new directory`;
  return { target, mode, existing, foreign, collisions, refusal, files };
}
/** Undoes an init: a new directory is deleted, an adopted one loses only what init created and gets its package.json back. */
export interface InitUndo { (): Promise<void> }
/**
 * `urlcode init <directory>`: one site layout, always. The route project lives in `app/`; `host.mjs` (the
 * operator host, initially with no extensions), `package.json` (exact runtime pin and scripts), AGENTS.md,
 * .mcp.json, the Makefile and the CI workflow sit beside it. Returns the site directory, the top-level entries it
 * left alone and an undo for callers that continue (init --with).
 */
export async function initSite(destination: string, options: InitOptions = {}): Promise<{ site: string; undo: InitUndo; leftAlone: string[] }> {
  const plan = await planInit(destination, options), { target } = plan;
  assert(plan.refusal === undefined, plan.refusal ?? '');
  const packageJson = plan.mode === 'in-place' && plan.existing.includes('package.json') ? await readFile(join(target, 'package.json'), 'utf8') : undefined;
  if (packageJson !== undefined) { try { JSON.parse(packageJson); } catch { assert(false, 'Existing package.json is not valid JSON'); } }
  await mkdir(dirname(target), { recursive: true });
  // A new directory is reserved exclusively before copying; an existing one is only ever added to.
  if (plan.mode === 'new') await mkdir(target);
  const existing = new Set(plan.existing), created: string[] = [];
  const undo: InitUndo = async () => {
    if (plan.mode === 'new') { await rm(target, { recursive: true, force: true }); return; }
    // Remove only what this run created and put package.json back; the user's own files are never touched.
    for (const path of [...created].reverse()) await rm(path, { recursive: true, force: true });
    for (const name of await readdir(target)) if (!existing.has(name)) await rm(join(target, name), { recursive: true, force: true });
    if (packageJson !== undefined) await writeFile(join(target, 'package.json'), packageJson);
  };
  // Parent directories are created one level at a time; an existing one is used only when it is a real directory.
  const directoryFor = async (segments: readonly string[]): Promise<void> => {
    for (let index = 1; index < segments.length; index += 1) {
      const directory = join(target, ...segments.slice(0, index)), info = await lstatOrUndefined(directory);
      if (info) { assert(info.isDirectory(), `${segments.slice(0, index).join('/')} changed during init; nothing of yours was overwritten`); continue; }
      await mkdir(directory); created.push(directory);
    }
  };
  const exclusive = async (path: string, content: string | Buffer, mode: number): Promise<void> => {
    const segments = path.split('/'), absolute = join(target, ...segments);
    await directoryFor(segments);
    // `wx` fails on anything already there, a symlink included, so an existing entry is never written through.
    const file = await open(absolute, 'wx', mode);
    created.push(absolute);
    try { await file.writeFile(content); } finally { await file.close(); }
  };
  try {
    const version = await runningCoreVersion();
    const generated = new Map<string, PlannedFile>();
    for (const file of plan.files) {
      if (!file.source) { generated.set(file.path, file); continue; }
      const content = await readFile(file.source);
      await exclusive(file.path, stampedStarterFiles.includes(file.path) ? stampStarterText(content.toString('utf8'), version) : content, file.mode);
    }
    const routes = Object.keys((await loadDocument(join(target, PROJECT_DIRECTORY))).routes).length;
    const write = async (path: string, content: string): Promise<void> => { const file = generated.get(path); if (file) await exclusive(path, content, file.mode); };
    await write(HOST_FILE, renderInitialHost());
    // AGENTS.md is generated from the installed runtime's capability catalog so it names only what this version
    // implements; the starter carries a committed copy for clones, kept identical by test.
    await write('AGENTS.md', renderAgentsGuide({ routes }));
    await write(mcpConfigFile, renderMcpConfig(PROJECT_DIRECTORY, { local: true }));
    const manifest = sitePackageJson(packageJson, target, version, routes);
    if (packageJson !== undefined) await writeFile(join(target, 'package.json'), manifest);
    else await write('package.json', manifest);
  } catch (error) { await undo(); throw error; }
  return { site: target, undo, leftAlone: plan.existing.filter(name => packageJson === undefined || name !== 'package.json') };
}
export async function initProject(destination: string, options: InitOptions = {}): Promise<string> { return (await initSite(destination, options)).site; }
export async function addRedirect(project: string, destination: string, alias?: string | undefined): Promise<string> {
  const loaded = await loadDocument(project);
  const slug = alias || randomBytes(6).toString('base64url');
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(slug), 'Alias must contain 1–128 letters, digits, underscores or hyphens');
  const pattern = '/' + slug;
  assert(!Object.hasOwn(loaded.routes, pattern), 'Alias already exists');
  const lockPath = join(loaded.root, 'urlcode.yaml.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  let temp: string | undefined;
  try {
    const file = join(loaded.root,'urlcode.yaml');
    const original = await readFile(file, 'utf8');
    // Reload under the lock to prevent competing authoring commands losing changes.
    const latest = await loadDocument(loaded.root);
    assert(!Object.hasOwn(latest.routes, pattern), 'Alias already exists');
    const doc = parseDocument(original, { uniqueKeys:false });
    doc.setIn(['routes', pattern], { redirect: { url: destination, status: 302 } });
    const data = validateDocument(doc.toJS());
    const added = data.routes[pattern];
    assert(added, 'Alias was not written');
    const routes = { ...latest.routes, [pattern]: added };
    const candidate: LoadedDocument = { ...latest, routes };
    const snapshot = await prepareFunctionSnapshot(candidate);
    // Authoring checks shape/references with dummy values; it must neither read
    // credentials nor execute code. This does not create an operator grant.
    const bindings: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const route of Object.values(routes)) {
      for (const ref of Object.values(route.env || {})) if (ref.env) bindings[ref.env] = 'validation-only';
      for (const ref of Object.values(route.secrets || {})) bindings[ref.secret] = 'validation-only';
    }
    await compileRoutes(candidate, bindings, requestedPermissions(candidate,snapshot), snapshot.projectSha256);
    temp = await mkdtemp(join(loaded.root, '.urlcode-edit-'));
    const temporary = join(temp, 'urlcode.yaml');
    const out = await open(temporary, 'wx', 0o600);
    try { await out.writeFile(String(doc)); await out.sync(); } finally { await out.close(); }
    assert(await readFile(file,'utf8') === original, 'Configuration changed during edit; retry');
    await rename(temporary, file);
    return pattern;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
    await lock.close(); await rm(lockPath, { force: true });
  }
}
