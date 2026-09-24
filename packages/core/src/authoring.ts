import { cp, readdir, mkdir, mkdtemp, rename, rm, readFile, writeFile, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
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
// A directory is accepted in place only when it holds nothing but what npm and git create, plus a pre-registered
// `.mcp.json` (see below): anything else is user work this command must never merge into.
const inPlaceEntries = new Set(['package.json', 'package-lock.json', 'node_modules', '.git', mcpConfigFile]);
interface ExistingDirectory { entries: Set<string>; packageJson: string | undefined }
async function inspectExisting(target: string): Promise<ExistingDirectory | undefined> {
  let names: string[];
  try { names = await readdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const unmergeable = names.filter(name => !inPlaceEntries.has(name));
  assert(!unmergeable.length, `Directory already contains ${unmergeable.slice(0, 5).join(', ')}; init into a new or empty directory, or one holding only package.json, package-lock.json, node_modules or .git`);
  const packageJson = names.includes('package.json') ? await readFile(join(target, 'package.json'), 'utf8') : undefined;
  if (packageJson !== undefined) { try { JSON.parse(packageJson); } catch { assert(false, 'Existing package.json is not valid JSON'); } }
  return { entries: new Set(names), packageJson };
}
/** Undoes an init: a new directory is deleted, an adopted one loses only what init created and gets its package.json back. */
export interface InitUndo { (): Promise<void> }
/**
 * `urlcode init <directory>`: one site layout, always. The route project lives in `app/`; `host.mjs` (the
 * operator host, initially with no extensions), `package.json` (exact runtime pin and scripts), AGENTS.md,
 * .mcp.json, the Makefile and the CI workflow sit beside it. Returns the site directory and an undo for callers
 * that continue (init --with).
 */
export async function initSite(destination: string): Promise<{ site: string; undo: InitUndo }> {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  const existing = await inspectExisting(target);
  // A new directory is reserved exclusively before copying; an existing one is only ever added to.
  if (!existing) await mkdir(target);
  const undo: InitUndo = async () => {
    if (!existing) { await rm(target, { recursive: true, force: true }); return; }
    // Remove only what this run created and put package.json back; the user's own files are never touched.
    for (const name of await readdir(target)) if (!existing.entries.has(name)) await rm(join(target, name), { recursive: true, force: true });
    if (existing.packageJson !== undefined) await writeFile(join(target, 'package.json'), existing.packageJson);
  };
  try {
    const source = fileURLToPath(new URL('../../../starters/default/', import.meta.url));
    for (const file of await readdir(source)) {
      if (file === '.gitignore' || file === 'AGENTS.md' || file === mcpConfigFile) continue;
      await cp(join(source, file), join(target, file === 'gitignore.template' ? '.gitignore' : file), { recursive: true, force: false, errorOnExist: true });
    }
    const version = await runningCoreVersion();
    for (const file of stampedStarterFiles) {
      const path = join(target, file), original = await readFile(path, 'utf8'), stamped = stampStarterText(original, version);
      if (stamped !== original) await writeFile(path, stamped);
    }
    const project = join(target, PROJECT_DIRECTORY);
    const routes = Object.keys((await loadDocument(project)).routes).length;
    const exclusive = async (name: string, content: string, mode = 0o644): Promise<void> => {
      const file = await open(join(target, name), 'wx', mode);
      try { await file.writeFile(content); } finally { await file.close(); }
    };
    await exclusive(HOST_FILE, renderInitialHost(), 0o600);
    // AGENTS.md is generated from the installed runtime's capability catalog so it names only what this version
    // implements; the starter carries a committed copy for clones, kept identical by test.
    await exclusive('AGENTS.md', renderAgentsGuide({ routes }));
    // .mcp.json registers the read-only server for repository-aware agents. A file already there (for example
    // `urlcode mcp print-config` run before the agent's session started) is kept exactly as written.
    if (!existing?.entries.has(mcpConfigFile)) await exclusive(mcpConfigFile, renderMcpConfig(PROJECT_DIRECTORY, { local: true }));
    const manifest = sitePackageJson(existing?.packageJson, target, version, routes);
    if (existing?.packageJson !== undefined) await writeFile(join(target, 'package.json'), manifest);
    else await exclusive('package.json', manifest);
  } catch (error) { await undo(); throw error; }
  return { site: target, undo };
}
export async function initProject(destination: string): Promise<string> { return (await initSite(destination)).site; }
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
