import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

// Renders the tap formula from the template and the exact published tarball, so
// a formula never carries a checksum that was not measured from real bytes.
const { values } = parseArgs({ options: {
  tarball:{type:'string'}, sha256:{type:'string'}, out:{type:'string', default:'candidate/urlcode.rb'},
} });
const pkg = JSON.parse(await readFile('package.json','utf8'));
let sha = values.sha256;
if (values.tarball) {
  const measured = createHash('sha256').update(await readFile(values.tarball)).digest('hex');
  assert.ok(!sha || sha === measured, `--sha256 ${sha} does not match ${values.tarball} (${measured})`);
  sha = measured;
}
assert.ok(/^[a-f0-9]{64}$/.test(sha || ''), 'Provide --tarball or a 64-character --sha256');
const template = await readFile(new URL('../packaging/homebrew/urlcode.rb.template', import.meta.url),'utf8');
const rendered = template
  .replace('__DESCRIPTION__', pkg.description.replace(/"/g,'\\"'))
  .replace('__VERSION__', pkg.version)
  .replace('__SHA256__', sha);
assert.ok(!/__[A-Z0-9_]+__/.test(rendered), 'Unfilled placeholder remains in the rendered formula');
await writeFile(values.out, rendered);
process.stdout.write(`${values.out}\n`);
