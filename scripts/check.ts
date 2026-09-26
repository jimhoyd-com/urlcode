import { readdir, readFile, lstat } from 'node:fs/promises';
import { recipeNames } from '../packages/core/src/recipes.ts';
import { exampleNames } from '../packages/core/src/examples.ts';
import { readMetadata, deriveMetadata, derivedDifferences, commandProblems } from '../packages/core/src/catalog.ts';
import { execFile } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { trackedTextFilesWithNul } from './nul-scan.ts';
// Syntax-check only the files no other gate already parses the way Node will.
// tsc (tsconfig.json `include`, erasableSyntaxOnly) covers every .ts under
// packages/core/src, test and scripts, so those are skipped. Everything else
// Node loads directly is checked: JavaScript modules with `node --check`
// (ESLint parses them too, but with its own parser, and Node's is the one that
// has to accept a project's function or the action's script), and .ts outside
// tsc's reach with Node's own type stripper, which alone decides whether the
// syntax is erasable (`node --check` does not strip types). Build output
// (dist/) and installed dependencies are generated, not authored: skipped.
const typeChecked = ['packages/core/src/', 'test/', 'scripts/'];
const javascript: string[] = [], typescript: string[] = [];
async function walk(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes:true })) {
    const file = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'dist' && e.name !== 'node_modules') await walk(file); }
    else if (/\.[cm]?js$/.test(file)) javascript.push(file);
    else if (/\.[cm]?ts$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && !typeChecked.some(prefix => file.startsWith(prefix))) typescript.push(file);
    else if (file.endsWith('.json')) JSON.parse(await readFile(file,'utf8'));
  }
}
for (const dir of ['packages/core/src','test','scripts','starters','schemas','examples','recipes','action']) await walk(dir);
const failures: string[] = [];
for (const file of typescript) {
  try { stripTypeScriptTypes(await readFile(file,'utf8')); }
  catch (error) { failures.push(`${file}\n${error instanceof Error ? error.message : String(error)}`); }
}
const run = promisify(execFile), queue = [...javascript];
await Promise.all(Array.from({ length: Math.min(availableParallelism(), queue.length) }, async () => {
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    try { await run(process.execPath, ['--check', file]); }
    catch (error) { failures.push(`${file}\n${(error as { stderr?: string }).stderr ?? String(error)}`); }
  }
}));
if (failures.length) { console.error(`Syntax check failed:\n${failures.sort().join('\n')}`); process.exit(1); }
const syntaxChecked = javascript.length + typescript.length;
// The Worker artifact bundles packages/core/src/cloudflare.ts and everything it imports at
// run time; a node: import anywhere in that closure breaks wrangler users.
// Type-only imports are erased before the bundler sees them.
const specifier = /^\s*(?:import|export)\s+(type\s+)?(?:[^'"\n]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm;
const seen = new Set<string>();
async function closure(file: string): Promise<void> {
  if (seen.has(file)) return; seen.add(file);
  for (const [, typeOnly, spec] of (await readFile(file,'utf8')).matchAll(specifier)) {
    if (typeOnly || spec === undefined) continue;
    if (spec.startsWith('node:')) { console.error(`${file} imports ${spec}, but it ships to the Worker`); process.exit(1); }
    if (spec.startsWith('.')) await closure(resolve(dirname(file), spec));
  }
}
await closure(resolve('packages/core/src/cloudflare.ts'));
// Recipe and example metadata: schema-valid, complete, and its derived fields
// (capabilities, targets, routes) equal to what the capability preflight says.
async function checkCatalog(kind: 'recipe'|'example', directory: string, names: readonly string[]): Promise<number> {
  const present = (await readdir(directory, { withFileTypes:true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  const listed = [...names].sort();
  if (JSON.stringify(present) !== JSON.stringify(listed)) { console.error(`${directory}/ has [${present}] but src lists [${listed}]`); process.exit(1); }
  for (const name of names) {
    const root = `${directory}/${name}/`;
    const metadata = await readMetadata(root, name, `${kind}.yaml`);
    for (const file of metadata.files) if (!(await lstat(root + file)).isFile()) { console.error(`${root}${kind}.yaml lists ${file}, which is not a file`); process.exit(1); }
    let runnable = true;
    try { await lstat(root + 'urlcode.yaml'); } catch { runnable = false; }
    if (runnable !== (metadata.runnable !== false)) { console.error(`${root}${kind}.yaml: runnable must be ${runnable}`); process.exit(1); }
    if (kind === 'recipe' && !metadata.files.includes('urlcode.yaml')) { console.error(`${root}recipe.yaml must copy urlcode.yaml`); process.exit(1); }
    const commands = commandProblems(metadata);
    if (commands.length) { console.error(`${root}${kind}.yaml lists commands a consumer cannot run:\n  ${commands.join('\n  ')}`); process.exit(1); }
    if (!runnable) {
      if (metadata.capabilities || metadata.targets || metadata.routes !== undefined) { console.error(`${root}${kind}.yaml is not runnable and must not carry derived fields`); process.exit(1); }
      continue;
    }
    const problems = derivedDifferences(metadata, await deriveMetadata(root));
    if (problems.length) { console.error(`${root}${kind}.yaml disagrees with the capability preflight:\n  ${problems.join('\n  ')}`); process.exit(1); }
  }
  return names.length;
}
const recipes = await checkCatalog('recipe', 'recipes', recipeNames), examples = await checkCatalog('example', 'examples', exampleNames);
console.log(`${recipes} recipes and ${examples} examples carry schema-valid metadata whose derived fields match the preflight`);
const nulFiles = await trackedTextFilesWithNul(process.cwd());
if (nulFiles.length) { console.error(`Literal NUL byte in tracked text file(s), which makes Git treat them as binary; write \\x00 instead:\n  ${nulFiles.join('\n  ')}`); process.exit(1); }
console.log(`Syntax (${syntaxChecked} files) and JSON checks passed; Worker closure of ${seen.size} modules is free of node: imports`);
