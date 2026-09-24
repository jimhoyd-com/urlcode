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
import { renderPackageManifest } from './project-dependencies.ts';
import type { DependencySet } from './project-dependencies.ts';
import type { LoadedDocument } from './types.ts';
import { projectScripts } from './context.ts';
import { runningCoreVersion } from './extension-bundles.ts';

/**
 * Points the copied starter's version-bearing references at the release of the runtime running init: the
 * editor `$schema` URL and the CI action ref. The committed starter carries the same values for clones (release
 * preparation bumps them), so this matters for a checkout between releases, but a fresh project must never name
 * a schema or action older than the runtime that wrote it.
 */
export function stampStarterText(text: string, version: string): string {
  return text
    .replace(/(https:\/\/raw\.githubusercontent\.com\/jimhoyd-com\/urlcode\/)[^/\s]+(\/schemas\/urlcode\.schema\.json)/g, `$1v${version}$2`)
    .replace(/(jimhoyd-com\/urlcode\/action@)[^\s#]+/g, `$1v${version}`);
}
const stampedStarterFiles = ['urlcode.yaml', '.github/workflows/urlcode.yml'];
// `npm init -y` writes this placeholder; replacing it is the only change init makes to an existing script.
const npmPlaceholderTest = 'echo "Error: no test specified" && exit 1';
/** Adds each missing project script, never overwriting one the user wrote; undefined when nothing changes. */
function withProjectScripts(packageJson: string, routes: number): string | undefined {
  const manifest = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  const scripts = { ...manifest.scripts };
  let changed = false;
  for (const [name, command] of Object.entries(projectScripts(routes))) {
    if (scripts[name] !== undefined && !(name === 'test' && scripts[name] === npmPlaceholderTest)) continue;
    scripts[name] = command; changed = true;
  }
  if (!changed) return undefined;
  const indent = /^\{\r?\n([ \t]+)"/.exec(packageJson)?.[1] ?? 2;
  return JSON.stringify({ ...manifest, scripts }, null, indent) + (packageJson.endsWith('\n') ? '\n' : '');
}

interface InitOptions {
  /**
   * When given, a `package.json` pinning exactly these versions is written beside `urlcode.yaml`. Route-only
   * initialization stays the default: a project whose runtime is managed elsewhere gets no manifest at all.
   */
  manifest?: DependencySet | undefined;
}
// Agents install the runtime before they can read its docs, so `init .` has to work after `npm init` and `npm install`.
// A directory is accepted in place only when it holds nothing but what npm and git create, plus a pre-registered
// `.mcp.json` (see below): anything else is user work this command must never merge into.
const inPlaceEntries = new Set(['package.json', 'package-lock.json', 'node_modules', '.git', mcpConfigFile]);
interface ExistingProject { entries: Set<string>; packageJson: string | undefined; pinned: boolean }
async function inspectExisting(target: string): Promise<ExistingProject | undefined> {
  let names: string[];
  try { names = await readdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const unmergeable = names.filter(name => !inPlaceEntries.has(name));
  assert(!unmergeable.length, `Directory already contains ${unmergeable.slice(0, 5).join(', ')}; init into a new or empty directory, or one holding only package.json, package-lock.json, node_modules or .git`);
  const packageJson = names.includes('package.json') ? await readFile(join(target, 'package.json'), 'utf8') : undefined;
  let pinned = false;
  if (packageJson !== undefined) {
    let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try { manifest = JSON.parse(packageJson); } catch { assert(false, 'Existing package.json is not valid JSON'); }
    pinned = Boolean(manifest.dependencies?.['@jimhoyd/urlcode'] ?? manifest.devDependencies?.['@jimhoyd/urlcode']);
  }
  return { entries: new Set(names), packageJson, pinned };
}
export async function initProject(destination: string, { manifest }: InitOptions = {}): Promise<string> {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  const existing = await inspectExisting(target);
  if (existing) assert(!(manifest && existing.packageJson !== undefined), '--manifest cannot write package.json over an existing one; drop --manifest and keep your package.json');
  // A new directory is reserved exclusively before copying; an existing one is only ever added to.
  if (!existing) await mkdir(target);
  try {
    const source = fileURLToPath(new URL('../../../starters/default/', import.meta.url));
    for (const file of await readdir(source)) {
      if (file === '.gitignore' || file === 'AGENTS.md' || file === mcpConfigFile) continue;
      await cp(join(source,file), join(target,file === 'gitignore.template' ? '.gitignore' : file), { recursive: true, force: false, errorOnExist: true });
    }
    const version = await runningCoreVersion();
    for (const file of stampedStarterFiles) {
      const path = join(target, file), original = await readFile(path, 'utf8'), stamped = stampStarterText(original, version);
      if (stamped !== original) await writeFile(path, stamped);
    }
    // AGENTS.md is generated from the installed runtime's capability catalog so
    // it names only what this version implements; the starter carries a
    // committed copy for clones, kept identical by test.
    const routes = Object.keys((await loadDocument(target)).routes).length;
    const guide = await open(join(target,'AGENTS.md'), 'wx', 0o644);
    try { await guide.writeFile(renderAgentsGuide({ routes })); } finally { await guide.close(); }
    // .mcp.json registers the read-only server for repository-aware agents; the starter carries the same bytes.
    // A file already there (for example `urlcode mcp print-config` run before the agent's session started, so a
    // project-scoped MCP client picks up the server from its very first turn) is kept exactly as written, never
    // regenerated: that is the documented pre-session bootstrap path, and this command must not fight it.
    if (!existing?.entries.has(mcpConfigFile)) {
      const mcp = await open(join(target,mcpConfigFile), 'wx', 0o644);
      try { await mcp.writeFile(renderMcpConfig('.', { local: manifest !== undefined || existing?.pinned === true })); } finally { await mcp.close(); }
    }
    if (manifest) {
      // Exclusive create: the starter ships no package.json, so this never merges into or overwrites one.
      const pkg = await open(join(target,'package.json'), 'wx', 0o644);
      const rendered = renderPackageManifest(target, manifest);
      try { await pkg.writeFile(withProjectScripts(rendered, routes) ?? rendered); } finally { await pkg.close(); }
    } else if (existing?.pinned && existing.packageJson !== undefined) {
      // A package.json that already pins the runtime gains the scripts that run it (a bare `urlcode` is not on
      // PATH for a local install); every existing key and script is kept, and the rollback below restores it.
      const updated = withProjectScripts(existing.packageJson, routes);
      if (updated !== undefined) await writeFile(join(target, 'package.json'), updated);
    }
  } catch (error) {
    if (!existing) await rm(target, { recursive: true, force: true });
    else {
      // Remove only what this run created and put package.json back; the user's own files are never touched.
      for (const name of await readdir(target)) if (!existing.entries.has(name)) await rm(join(target, name), { recursive: true, force: true });
      if (existing.packageJson !== undefined) await writeFile(join(target, 'package.json'), existing.packageJson);
    }
    throw error;
  }
  return target;
}
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
