import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes:true })) {
    const file = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(file);
    else if (/\.(?:js|mjs)$/.test(file)) {
      const result = spawnSync(process.execPath,['--check',file],{ stdio:'inherit' });
      if (result.status !== 0) process.exit(1);
    } else if (file.endsWith('.json')) JSON.parse(await readFile(file,'utf8'));
  }
}
for (const dir of ['src','test','scripts','benchmarks','starters','schemas','examples']) await walk(dir);
console.log('JavaScript syntax and JSON checks passed');
