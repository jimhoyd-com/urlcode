// A stand-in for npm used by the add-on tests (URLCODE_NPM). `install` links every `file:` dependency of the site's
// package.json into node_modules/, and a `name@version` dependency from $FAKE_NPM_REGISTRY/<name with / as +>@<version>
// when that directory exists, and writes the package-lock.json entries npm writes for linked directories. Like npm 7+,
// it also installs each linked package's peerDependencies (from the registry, marked `peer`) and copies a package's
// dependency fields into its lock entry. `ci` rebuilds node_modules from package-lock.json alone and never writes the
// lock. It appends each invocation to $FAKE_NPM_LOG so tests can assert what ran. $FAKE_NPM_FAIL fails a matching
// command before it touches anything; $FAKE_NPM_FAIL_AFTER fails it after it has changed node_modules and the lock,
// as a real npm can. `view` answers from $FAKE_NPM_VIEW (JSON).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2), cwd = process.cwd();
if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\n');
if (process.env.FAKE_NPM_FAIL && args.includes(process.env.FAKE_NPM_FAIL)) { process.stderr.write('fake npm failure\n'); process.exit(1); }
if (args[0] === 'view') { process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_NPM_VIEW ?? 'null'))); process.exit(0); }
const registry = process.env.FAKE_NPM_REGISTRY;
const inRegistry = (name, spec) => registry && existsSync(join(registry, `${name.replace('/', '+')}@${spec}`)) ? join(registry, `${name.replace('/', '+')}@${spec}`) : undefined;
const link = (from, name) => { const target = join(cwd, 'node_modules', name); mkdirSync(join(target, '..'), { recursive: true }); if (!existsSync(target)) symlinkSync(from, target, 'dir'); };

if (args[0] === 'ci') {
  if (!existsSync(join(cwd, 'package-lock.json'))) { process.stderr.write('fake npm ci: no package-lock.json\n'); process.exit(1); }
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(cwd, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.slice('node_modules/'.length), from = entry.link ? entry.resolved : inRegistry(name, entry.version);
    if (!from) { process.stderr.write(`fake npm ci: cannot fetch ${name}\n`); process.exit(1); }
    link(from, name);
  }
  process.exit(0);
}
if (args[0] !== 'install') process.exit(0);
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const scope = join(cwd, 'node_modules', '@jimhoyd');
mkdirSync(scope, { recursive: true });
const source = (name, spec) => spec.startsWith('file:') ? spec.slice(5) : inRegistry(name, spec);
for (const name of readdirSync(scope)) { rmSync(join(scope, name), { recursive: true, force: true }); }
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) if (!source(name, spec) && registry) { process.stderr.write(`fake npm: no ${name}@${spec}\n`); process.exit(1); }
const packages = { '': { name: pkg.name, dependencies: pkg.dependencies } };
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bin'];
const peers = [];
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  const from = source(name, spec);
  if (!from) continue;
  link(from, name);
  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
  packages[`node_modules/${name}`] = { version: manifest.version, resolved: spec.startsWith('file:') ? from : `https://registry.example/${name}/-/${spec}.tgz`, link: spec.startsWith('file:') };
  for (const field of dependencyFields) if (manifest[field] !== undefined) packages[`node_modules/${name}`][field] = manifest[field];
  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[peer]?.optional) peers.push([peer, range]);
}
for (const [peer, range] of peers) {
  const from = inRegistry(peer, range);
  if (!from || packages[`node_modules/${peer}`]) continue;
  link(from, peer);
  packages[`node_modules/${peer}`] = { version: range, resolved: `https://registry.example/${peer}/-/${range}.tgz`, peer: true };
}
writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3, packages }, null, 2) + '\n');
if (process.env.FAKE_NPM_FAIL_AFTER && args.includes(process.env.FAKE_NPM_FAIL_AFTER)) { process.stderr.write('fake npm failure after extracting\n'); process.exit(1); }
