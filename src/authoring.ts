import { cp, readdir, mkdir, mkdtemp, rename, rm, readFile, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseDocument } from 'yaml';
import { loadDocument, validateDocument } from './config.ts';
import { compileRoutes } from './router.ts';
import { prepareFunctionSnapshot, requestedPermissions } from './policy.ts';
import { assert } from './errors.ts';

export async function initProject(destination) {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  // Reserve destination before copying; never merge into existing user files.
  await mkdir(target);
  try {
    const source = fileURLToPath(new URL('../starters/default/', import.meta.url));
    for (const file of await readdir(source)) {
      if (file === '.gitignore') continue;
      await cp(join(source,file), join(target,file === 'gitignore.template' ? '.gitignore' : file), { recursive: true, force: false, errorOnExist: true });
    }
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
  return target;
}
export async function addRedirect(project, destination, alias) {
  const loaded = await loadDocument(project);
  const slug = alias || randomBytes(6).toString('base64url');
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(slug), 'Alias must contain 1–128 letters, digits, underscores or hyphens');
  const pattern = '/' + slug;
  assert(!Object.hasOwn(loaded.routes, pattern), 'Alias already exists');
  const lockPath = join(loaded.root, 'urlcode.yaml.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  let temp;
  try {
    const file = join(loaded.root,'urlcode.yaml');
    const original = await readFile(file, 'utf8');
    // Reload under the lock to prevent competing authoring commands losing changes.
    const latest = await loadDocument(loaded.root);
    assert(!Object.hasOwn(latest.routes, pattern), 'Alias already exists');
    const doc = parseDocument(original, { uniqueKeys:false });
    doc.setIn(['routes', pattern], { redirect: { url: destination, status: 302 } });
    const data = validateDocument(doc.toJS());
    const routes = { ...latest.routes, [pattern]: data.routes[pattern] };
    const candidate = { ...latest, routes };
    const snapshot = await prepareFunctionSnapshot(candidate);
    // Authoring checks shape/references with dummy values; it must neither read
    // credentials nor execute code. This does not create an operator grant.
    const bindings = Object.create(null);
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
