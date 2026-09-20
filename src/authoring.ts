import { cp, readdir, mkdir, mkdtemp, rename, rm, readFile, open } from 'node:fs/promises';
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

export interface InitOptions {
  /**
   * When given, a `package.json` pinning exactly these versions is written beside `urlcode.yaml`. Route-only
   * initialization stays the default: a project whose runtime is managed elsewhere gets no manifest at all.
   */
  manifest?: DependencySet | undefined;
  /** `default` (function, middleware, redirect) or `page`: urlcode.yaml, public/index.html, a README and fixtures only. */
  template?: 'default' | 'page' | undefined;
}
export async function initProject(destination: string, { manifest, template = 'default' }: InitOptions = {}): Promise<string> {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  // Reserve destination before copying; never merge into existing user files.
  await mkdir(target);
  try {
    const source = fileURLToPath(new URL(`../starters/${template === 'page' ? 'page' : 'default'}/`, import.meta.url));
    for (const file of await readdir(source)) {
      if (file === '.gitignore' || file === 'AGENTS.md' || file === mcpConfigFile) continue;
      await cp(join(source,file), join(target,file === 'gitignore.template' ? '.gitignore' : file), { recursive: true, force: false, errorOnExist: true });
    }
    if (template === 'page') {
      await loadDocument(target);
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
    try { await mcp.writeFile(renderMcpConfig('.')); } finally { await mcp.close(); }
    if (manifest) {
      // Exclusive create: the starter ships no package.json, so this never merges into or overwrites one.
      const pkg = await open(join(target,'package.json'), 'wx', 0o644);
      try { await pkg.writeFile(renderPackageManifest(target, manifest)); } finally { await pkg.close(); }
    }
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
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
