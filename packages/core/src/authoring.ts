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
import { redirectStarter } from './context.ts';
import type { LoadedDocument } from './types.ts';

export interface InitOptions {
  /**
   * When given, a `package.json` pinning exactly these versions is written beside `urlcode.yaml`. Route-only
   * initialization stays the default: a project whose runtime is managed elsewhere gets no manifest at all.
   */
  manifest?: DependencySet | undefined;
  /** `default` (function, middleware, redirect) or `page`: urlcode.yaml, public/index.html, a README and fixtures only. */
  template?: 'default' | 'page' | 'redirects' | undefined;
}
// Agents install the runtime before they can read its docs, so `init .` has to work after `npm init` and `npm install`.
// A directory is accepted in place only when it holds nothing but what npm and git create; anything else is user work
// this command must never merge into.
const inPlaceEntries = new Set(['package.json', 'package-lock.json', 'node_modules', '.git']);
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
/** Adds what the starter needs to an existing package.json and changes nothing else; a conflicting script is refused, never overwritten. */
export function mergePackageJson(text: string, scripts: Record<string, string>, dependency: string, version: string): string {
  const manifest = JSON.parse(text) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  for (const [name, command] of Object.entries(scripts)) {
    const current = manifest.scripts?.[name];
    assert(current === undefined || current === command, `package.json already defines scripts.${name}; remove it or set it to: ${command}`);
    manifest.scripts = { ...manifest.scripts, [name]: command };
  }
  if (manifest.dependencies?.[dependency] === undefined && manifest.devDependencies?.[dependency] === undefined) manifest.dependencies = { ...manifest.dependencies, [dependency]: version };
  return JSON.stringify(manifest, null, 2) + '\n';
}
export async function initProject(destination: string, { manifest, template = 'default' }: InitOptions = {}): Promise<string> {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  const existing = await inspectExisting(target);
  if (existing) assert(!(manifest && existing.packageJson !== undefined), '--manifest cannot write package.json over an existing one; drop --manifest and keep your package.json');
  // A new directory is reserved exclusively before copying; an existing one is only ever added to.
  if (!existing) await mkdir(target);
  try {
    if (template === 'redirects') { await writeRedirectsStarter(target, existing); return target; }
    const source = fileURLToPath(new URL(`../../../starters/${template === 'page' ? 'page' : 'default'}/`, import.meta.url));
    for (const file of await readdir(source)) {
      if (file === '.gitignore' || file === 'AGENTS.md' || file === mcpConfigFile) continue;
      await cp(join(source,file), join(target,file === 'gitignore.template' ? '.gitignore' : file), { recursive: true, force: false, errorOnExist: true });
    }
    if (template === 'page') {
      const routes = Object.keys((await loadDocument(target)).routes).length;
      // The page starter is the smallest project, but an agent opened in it still needs the same first-step guidance and MCP registration.
      await writeExclusive(join(target, 'AGENTS.md'), renderAgentsGuide({ routes }));
      await writeExclusive(join(target, mcpConfigFile), renderMcpConfig('.', { local: manifest !== undefined || existing?.pinned === true }));
      if (manifest) {
        const pkg = await open(join(target,'package.json'), 'wx', 0o644);
        try { await pkg.writeFile(renderPackageManifest(target, manifest)); } finally { await pkg.close(); }
      }
      return target;
    }
    // AGENTS.md is generated from the installed runtime's capability catalog so
    // it names only what this version implements; the starter carries a
    // committed copy for clones, kept identical by test.
    const routes = Object.keys((await loadDocument(target)).routes).length;
    const guide = await open(join(target,'AGENTS.md'), 'wx', 0o644);
    try { await guide.writeFile(renderAgentsGuide({ routes })); } finally { await guide.close(); }
    // .mcp.json registers the read-only server for repository-aware agents; the starter carries the same bytes.
    const mcp = await open(join(target,mcpConfigFile), 'wx', 0o644);
    try { await mcp.writeFile(renderMcpConfig('.', { local: manifest !== undefined || existing?.pinned === true })); } finally { await mcp.close(); }
    if (manifest) {
      // Exclusive create: the starter ships no package.json, so this never merges into or overwrites one.
      const pkg = await open(join(target,'package.json'), 'wx', 0o644);
      try { await pkg.writeFile(renderPackageManifest(target, manifest)); } finally { await pkg.close(); }
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
const redirectFixtures = [
  { path: '/old', status: 301, expectHeaders: { location: 'https://example.com/new' } },
  { path: '/users/42', status: 308, expectHeaders: { location: 'https://example.com/profiles/42' } },
  { path: '/people/7', status: 302, expectHeaders: { location: '/profiles/7' } },
  { path: '/legacy/a/b/c/d/e/f/g/h/i', status: 302, expectHeaders: { location: 'https://example.com/modern/a/b/c/d/e/f/g/h/i' } },
  { path: '/search?q=tea', status: 302, expectHeaders: { location: 'https://example.com/find?q=tea' } },
  { path: '/missing', status: 404 },
];
/** The redirect starter is the `--task redirects` starter, so init and `urlcode context` cannot disagree. */
async function writeRedirectsStarter(target: string, existing?: ExistingProject): Promise<void> {
  const starter = redirectStarter();
  const version = (JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  const files: Record<string, string> = {
    [starter.file]: starter.yaml,
    ...starter.companions,
    'tests/requests.json': JSON.stringify(redirectFixtures, null, 2) + '\n',
  };
  await mkdir(join(target, 'tests'));
  for (const [name, body] of Object.entries(files)) await writeExclusive(join(target, name), body);
  if (existing?.packageJson !== undefined) await writeFile(join(target, 'package.json'), mergePackageJson(existing.packageJson, starter.packageScripts, '@jimhoyd/urlcode', version));
  else await writeExclusive(join(target, 'package.json'), JSON.stringify({ name: 'redirects', version: '1.0.0', private: true, scripts: starter.packageScripts, dependencies: { '@jimhoyd/urlcode': version } }, null, 2) + '\n');
  const routes = Object.keys((await loadDocument(target)).routes).length;
  await writeExclusive(join(target, 'AGENTS.md'), renderAgentsGuide({ routes }));
  await writeExclusive(join(target, mcpConfigFile), renderMcpConfig('.', { local: true }));
}
async function writeExclusive(file: string, body: string): Promise<void> {
  const handle = await open(file, 'wx', 0o644);
  try { await handle.writeFile(body); } finally { await handle.close(); }
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
