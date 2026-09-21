// Every label an issue template applies must exist, or GitHub rejects the issue.
// Labels cannot be queried offline, so .github/labels.json pins the known set.
import { readdir, readFile } from 'node:fs/promises';

const dir = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
const known = new Set(
  (JSON.parse(await readFile(new URL('../.github/labels.json', import.meta.url), 'utf8')) as { labels: string[] }).labels,
);
const failures: string[] = [];
let checked = 0;
for (const file of await readdir(dir)) {
  if (!/\.ya?ml$/.test(file) || file === 'config.yml') continue;
  const text = await readFile(new URL(file, dir), 'utf8');
  const match = /^labels:\s*(?:\[(.*)\]|((?:\n\s+-\s*.+)+))/m.exec(text);
  if (!match) continue;
  const names = (match[1] ?? match[2] ?? '')
    .split(/,|\n\s+-/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  for (const name of names) {
    checked += 1;
    if (!known.has(name)) failures.push(`${file}: label "${name}" is not in .github/labels.json`);
  }
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error('Point the template at an existing label, or have a maintainer create the label and add it to .github/labels.json.');
  process.exit(1);
}
console.log(`issue-template labels ok (${checked} checked)`);
