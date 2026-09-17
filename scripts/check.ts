import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes:true })) {
    const file = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(file);
    else if (/\.(?:js|mjs|ts)$/.test(file)) {
      const result = spawnSync(process.execPath,['--check',file],{ stdio:'inherit' });
      if (result.status !== 0) process.exit(1);
    } else if (file.endsWith('.json')) JSON.parse(await readFile(file,'utf8'));
  }
}
for (const dir of ['src','test','scripts','benchmarks','starters','schemas','examples']) await walk(dir);
// The Worker artifact bundles src/cloudflare.ts and everything it imports at
// run time; a node: import anywhere in that closure breaks wrangler users.
// Type-only imports are erased before the bundler sees them.
const specifier = /^\s*(?:import|export)\s+(type\s+)?(?:[^'"\n]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm;
const seen = new Set();
async function closure(file) {
  if (seen.has(file)) return; seen.add(file);
  for (const [, typeOnly, spec] of (await readFile(file,'utf8')).matchAll(specifier)) {
    if (typeOnly) continue;
    if (spec.startsWith('node:')) { console.error(`${file} imports ${spec}, but it ships to the Worker`); process.exit(1); }
    if (spec.startsWith('.')) await closure(resolve(dirname(file), spec));
  }
}
await closure(resolve('src/cloudflare.ts'));
console.log(`Syntax and JSON checks passed; Worker closure of ${seen.size} modules is free of node: imports`);
