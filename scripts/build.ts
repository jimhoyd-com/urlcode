// Emits dist/ from src/ with Node's own type stripping, the transform that runs
// the .ts sources in development: types become whitespace, so every line and
// column of dist/x.js equals src/x.ts. The only other edit is the relative
// specifier extension (.ts -> .js), because Node refuses to strip types under
// node_modules, so the published package must be JavaScript. Declarations for
// the public exports come from tsc, which never touches runtime output.
import { readdir, readFile, writeFile, mkdir, rm, cp, access } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), quiet = args.includes('--quiet');
const root = resolve(args.find(arg => arg !== '--quiet') ?? '.'), out = join(root, 'dist');
// Any quoted relative path ending in .ts that names a source module: static
// and dynamic import specifiers, worker entry URLs and the deliberately
// non-literal loader string in policies/agents.ts.
const specifier = /(['"])(\.{1,2}\/[^'"\n]+?\.ts)\1/g;
// Runtime data is adjacent to dist/ in published and container layouts, while
// the TypeScript sources live under packages/core. Keep source reads rooted in
// the repository but emit the package-relative location into dist/.
const coreAssetSpecifier = /(['"`])((?:\.\.\/){3,})/g;
const exists = (file: string) => access(file).then(() => true, () => false);
// packages/core/src/x.ts becomes dist/x.js; scripts/x.ts becomes dist/scripts/x.js.
const emitted = (source: string) => join(out, relative(root, source).replace(/^packages[\\/]core[\\/]src[\\/]/, '').replace(/\.ts$/, '.js'));
async function walk(dir: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await walk(file, files); else files.push(file);
  }
  return files;
}
await rm(out, { recursive: true, force: true });
const manifest: Record<string, string> = {};
// The container CI job mounts and runs the operational drills against the image.
for (const file of [...await walk(join(root, 'packages', 'core', 'src')), join(root, 'scripts', 'operational-drills.ts')]) {
  const rel = relative(root, file), target = emitted(file);
  await mkdir(dirname(target), { recursive: true });
  if (!file.endsWith('.ts')) { await cp(file, target); continue; }
  const source = await readFile(file, 'utf8');
  let stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  for (const [whole, quote, path] of stripped.matchAll(specifier)) {
    const imported = resolve(dirname(file), path!);
    if (!await exists(imported)) throw new Error(`${rel}: ${path} does not name a source module`);
    const rewritten = relative(dirname(target), emitted(imported)).replaceAll('\\', '/');
    stripped = stripped.replace(whole, `${quote}${rewritten.startsWith('.') ? rewritten : `./${rewritten}`}${quote}`);
  }
  if (/['"]\.{1,2}\/[^'"\n]+\.ts['"]/.test(stripped)) throw new Error(`${rel}: a .ts specifier survived the build`);
  stripped = stripped.replace(coreAssetSpecifier, (_whole, quote: string, sourcePath: string) =>
    quote + '../'.repeat(sourcePath.length / 3 - 2));
  if (stripped.split('\n').length !== source.split('\n').length) throw new Error(`${rel}: emitted line count differs from source`);
  await writeFile(target, stripped);
  manifest[relative(root, target).replaceAll('\\', '/')] = createHash('sha256').update(stripped).digest('hex');
}
// Declarations come from tsc; the runtime output above never depends on it.
// Any type error fails the build: the published declarations must describe
// exactly the source that was stripped.
const tsc = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { encoding: 'utf8' });
if (tsc.status !== 0 || !await exists(join(out, 'types', 'index.d.ts'))) throw new Error(`declaration emit failed\n${tsc.stdout}${tsc.stderr}`);
await writeFile(join(out, 'BUILD-MANIFEST.json'), JSON.stringify({ node: process.version, files: manifest }, null, 2) + '\n');
if (!quiet) console.log(`built ${Object.keys(manifest).length} modules into dist/`);
