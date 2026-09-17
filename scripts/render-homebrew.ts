import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

// Renders the tap formula from the template and the exact published tarball, so
// a formula never carries a checksum that was not measured from real bytes.
const { values } = parseArgs({ options: {
  tarball:{type:'string'}, sha256:{type:'string'}, out:{type:'string', default:'candidate/urlcode.rb'},
} });
// JSON boundary: package.json fields are validated below before use.
const pkg = JSON.parse(await readFile('package.json','utf8')) as { name?: unknown; version?: unknown; description?: unknown };
let sha = values.sha256;
if (values.tarball) {
  const measured = createHash('sha256').update(await readFile(values.tarball)).digest('hex');
  assert.ok(!sha || sha === measured, `--sha256 ${sha} does not match ${values.tarball} (${measured})`);
  sha = measured;
}
assert.ok(sha !== undefined && /^[a-f0-9]{64}$/.test(sha), 'Provide --tarball or a 64-character --sha256');
// The rendered formula is Ruby that Homebrew executes, so text taken from
// package.json is escaped completely: a backslash, a quote or a `#{}` left
// intact would change what the formula does, not just how it reads.
function rubyString(value: unknown): string {
  assert.ok(typeof value === 'string', 'package.json text field must be a string');
  assert.ok(!/[\u0000-\u001f\u007f]/.test(value), 'Control characters cannot be rendered into a formula');
  return value.replace(/[\\"#]/g, character => '\\' + character);
}
// A formula is Ruby that Homebrew executes and a URL it downloads, so the name
// is validated against npm's own grammar before it reaches either.
assert.ok(typeof pkg.name === 'string' && /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg.name),
  'package.json name is not a publishable npm package name');
assert.ok(typeof pkg.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), 'package.json version is not a plain semantic version');
// The registry lays a scoped package out as /@scope/name/-/name-version.tgz:
// the directory keeps the scope and the file drops it. Deriving both from
// package.json keeps the formula from naming a package that was never packed.
function registryTarball(name: string, version: string) {
  const bare = name.split('/').pop();
  return `https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz`;
}
const template = await readFile(new URL('../packaging/homebrew/urlcode.rb.template', import.meta.url),'utf8');
const rendered = template
  .replace('__DESCRIPTION__', rubyString(pkg.description))
  .replace('__URL__', registryTarball(pkg.name, pkg.version))
  .replace('__VERSION__', pkg.version)
  .replace('__SHA256__', sha);
assert.ok(!/__[A-Z0-9_]+__/.test(rendered), 'Unfilled placeholder remains in the rendered formula');
await writeFile(values.out, rendered);
process.stdout.write(`${values.out}\n`);
