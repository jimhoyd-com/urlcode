// Emits dist/ from src/ with Node's own type stripping, the transform that runs
// the .ts sources in development: types become whitespace, so every line and
// column of dist/x.js equals src/x.ts. The only other edit is the relative
// specifier extension (.ts -> .js), because Node refuses to strip types under
// node_modules, so the published package must be JavaScript. Declarations for
// the public exports come from tsc, which never touches runtime output.
import { readdir, readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] ?? '.'), out = join(root, 'dist');
// Any quoted relative path ending in .ts that names a source module: static
// and dynamic import specifiers, worker entry URLs and the deliberately
// non-literal loader string in policies/agents.ts.
const specifier = /(['"])(\.{1,2}\/[^'"\n]+?\.ts)\1/g;
import { access } from 'node:fs/promises';
const exists = (file: string) => access(file).then(() => true, () => false);
async function walk(dir: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await walk(file, files); else files.push(file);
  }
  return files;
}
await rm(out, { recursive: true, force: true });
const manifest: Record<string, string> = {};
for (const file of await walk(join(root, 'src'))) {
  const rel = relative(root, file), target = join(out, rel.replace(/^src[\\/]/, '').replace(/\.ts$/, '.js'));
  await mkdir(dirname(target), { recursive: true });
  if (!file.endsWith('.ts')) { await cp(file, target); continue; }
  const source = await readFile(file, 'utf8');
  let stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  for (const [whole, quote, path] of stripped.matchAll(specifier)) {
    if (!await exists(resolve(dirname(file), path))) throw new Error(`${rel}: ${path} does not name a source module`);
    stripped = stripped.replace(whole, `${quote}${path.replace(/\.ts$/, '.js')}${quote}`);
  }
  if (/['"]\.{1,2}\/[^'"\n]+\.ts['"]/.test(stripped)) throw new Error(`${rel}: a .ts specifier survived the build`);
  if (stripped.split('\n').length !== source.split('\n').length) throw new Error(`${rel}: emitted line count differs from source`);
  await writeFile(target, stripped);
  manifest[relative(root, target)] = createHash('sha256').update(stripped).digest('hex');
}
await writeFile(join(out, 'BUILD-MANIFEST.json'), JSON.stringify({ node: process.version, files: manifest }, null, 2) + '\n');
console.log(`built ${Object.keys(manifest).length} modules into dist/`);
