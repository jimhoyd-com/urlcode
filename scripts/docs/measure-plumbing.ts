// Counts the plumbing the store's declared `intervals` and `transfers` remove (#902 item 6), for docs/FRAMEWORK.md
// "Plumbing removed by intervals and transfers". Each pair is a catalog recipe (the declaration) and its
// host-transaction counterexample in packages/store/test/plumbing/, which packages/store/test/plumbing.test.ts runs
// against the recipe's own fixtures. Counts are of the checkout, so they move with the files:
//
//   node scripts/docs/measure-plumbing.ts           a Markdown table
//   node scripts/docs/measure-plumbing.ts --json    the same numbers as JSON
//
// A line counts when it is not blank and not only a comment: `#` lines in YAML; `//` lines and the lines of a `/* */`
// block in JavaScript. Physical lines (`wc -l`, what the #843 approval's "127 lines removed" counted) are reported too.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
// The host.mjs lines a counterexample adds, beyond the recipe's own host: one import and one entry in composeHost.
const hostRegistration = 2;
const pairs = [
  { name: 'Scheduling (store-booking)', declared: ['recipes/store-booking/urlcode.yaml'], host: ['packages/store/test/plumbing/booking/urlcode.yaml', 'packages/store/test/plumbing/booking/bookings.mjs'] },
  { name: 'Credits (store-credits)', declared: ['recipes/store-credits/urlcode.yaml'], host: ['packages/store/test/plumbing/credits/urlcode.yaml', 'packages/store/test/plumbing/credits/wallets.mjs'] },
];

type Kind = 'yaml' | 'code';
interface Count { yaml: number; code: number; physical: number }

/** Code lines of one file: not blank, not only a comment. */
function count(path: string): { kind: Kind; lines: number; physical: number } {
  const text = readFileSync(join(root, path), 'utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const yaml = ['.yaml', '.yml'].includes(extname(path));
  let block = false, counted = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (block) { if (line.includes('*/')) block = false; continue; }
    if (line === '') continue;
    if (yaml ? line.startsWith('#') : line.startsWith('//')) continue;
    if (!yaml && line.startsWith('/*')) { block = !line.includes('*/'); continue; }
    counted++;
  }
  return { kind: yaml ? 'yaml' : 'code', lines: counted, physical: lines.length };
}
function total(paths: string[], extra = 0): Count {
  const sum: Count = { yaml: 0, code: extra, physical: extra };
  for (const path of paths) { const { kind, lines, physical } = count(path); sum[kind] += lines; sum.physical += physical; }
  return sum;
}

const rows = pairs.map(pair => ({ name: pair.name, declared: total(pair.declared), host: total(pair.host, hostRegistration) }));
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('| Contract | Declared: YAML / code | Host transaction: YAML / code | Code removed | Physical lines, declared / host |');
  console.log('|---|---:|---:|---:|---:|');
  for (const { name, declared, host } of rows) {
    console.log(`| ${name} | ${declared.yaml} / ${declared.code} | ${host.yaml} / ${host.code} | ${host.code - declared.code} | ${declared.physical} / ${host.physical} |`);
  }
}
