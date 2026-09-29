// A stand-in for npm used by the add-on tests (URLCODE_NPM). `install` links every `file:` directory dependency of the
// site's package.json into node_modules/, and a `name@version` dependency from $FAKE_NPM_REGISTRY/<name with / as
// +>@<version> when that directory exists, and writes the package-lock.json entries npm writes for linked directories.
// Tarballs are unpacked, as npm installs them: a `file:….tgz` dependency, or a registry version held as
// $FAKE_NPM_REGISTRY/<name with / as +>@<version>.tgz (locked as resolved from $FAKE_NPM_TARBALL_BASE, default
// https://registry.example/-/), each locked with its sha512 integrity and left alone while that integrity is unchanged.
// `install <spec>` saves a directory or tarball as `file:<absolute path>` and a registry spec as its exact version (the
// newest tarball when the spec names no version). Like npm 7+, it also installs each linked package's
// peerDependencies (from the registry, marked `peer`) and copies a package's dependency fields into its lock entry.
// A tarball that carries its own node_modules (bundleDependencies) gets a lock entry for each bundled package, marked
// `inBundle`, as npm writes one: `node_modules/<name>/node_modules/<bundled>`.
// `ci` rebuilds node_modules from package-lock.json alone and never writes the lock. It appends each invocation to
// $FAKE_NPM_LOG so tests can assert what ran. $FAKE_NPM_FAIL fails a matching command before it touches anything;
// $FAKE_NPM_FAIL_AFTER fails it after it has changed node_modules and the lock, as a real npm can. `view` answers
// from $FAKE_NPM_VIEW (JSON).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractTarball } from './tarball.mjs';

const args = process.argv.slice(2), cwd = process.cwd();
if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\n');
if (process.env.FAKE_NPM_FAIL && args.includes(process.env.FAKE_NPM_FAIL)) { process.stderr.write('fake npm failure\n'); process.exit(1); }
if (args[0] === 'view') { process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_NPM_VIEW ?? 'null'))); process.exit(0); }
const registry = process.env.FAKE_NPM_REGISTRY, tarballBase = process.env.FAKE_NPM_TARBALL_BASE ?? 'https://registry.example/-/';
const plus = name => name.replace('/', '+');
const inRegistry = (name, spec) => registry && existsSync(join(registry, `${plus(name)}@${spec}`)) ? join(registry, `${plus(name)}@${spec}`) : undefined;
const registryTarball = (name, version) => registry && existsSync(join(registry, `${plus(name)}@${version}.tgz`)) ? join(registry, `${plus(name)}@${version}.tgz`) : undefined;
const link = (from, name) => { const target = join(cwd, 'node_modules', name); mkdirSync(join(target, '..'), { recursive: true }); if (!existsSync(target)) symlinkSync(from, target, 'dir'); };
const integrityOf = file => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
/** Unpacks `file` as node_modules/<name> unless that directory already holds the same tarball. */
const unpack = (file, name, previous) => {
  const target = join(cwd, 'node_modules', name);
  let kept;
  try { kept = previous === integrityOf(file) && lstatSync(target).isDirectory(); } catch { kept = false; }
  if (kept) return;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  extractTarball(readFileSync(file), target);
};
const manifestOfTarball = file => { const dir = mkdtempSync(join(tmpdir(), 'fake-npm-')); try { extractTarball(readFileSync(file), dir); return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } finally { rmSync(dir, { recursive: true, force: true }); } };
const newest = name => registry ? readdirSync(registry).filter(file => file.startsWith(`${plus(name)}@`) && file.endsWith('.tgz')).map(file => file.slice(plus(name).length + 1, -4)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1) : undefined;

if (args[0] === 'ci') {
  if (!existsSync(join(cwd, 'package-lock.json'))) { process.stderr.write('fake npm ci: no package-lock.json\n'); process.exit(1); }
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(cwd, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || entry.inBundle) continue;
    const name = key.slice('node_modules/'.length);
    const tarball = entry.integrity && entry.resolved?.startsWith('file:') ? entry.resolved.slice(5) : entry.integrity && entry.resolved?.startsWith(tarballBase) ? registryTarball(name, entry.version) : undefined;
    if (tarball) { unpack(tarball, name); continue; }
    const from = entry.link ? entry.resolved : inRegistry(name, entry.version);
    if (!from) { process.stderr.write(`fake npm ci: cannot fetch ${name}\n`); process.exit(1); }
    link(from, name);
  }
  process.exit(0);
}
if (args[0] !== 'install') process.exit(0);
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const previousLock = existsSync(join(cwd, 'package-lock.json')) ? JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')).packages ?? {} : {};
// `install [flags] <spec>…` saves each spec first, as npm --save-exact does.
for (const spec of args.slice(1).filter(arg => !arg.startsWith('-'))) {
  const from = resolve(cwd, spec.startsWith('file:') ? spec.slice(5) : spec);
  let name, saved;
  if (from.endsWith('.tgz') && existsSync(from)) { name = manifestOfTarball(from).name; saved = `file:${from}`; }
  else if (existsSync(join(from, 'package.json'))) { name = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).name; saved = `file:${from}`; }
  else {
    const match = /^((?:@[^/@]+\/)?[^@]+)(?:@(.+))?$/.exec(spec);
    const version = match && (match[2] ?? newest(match[1]));
    if (!match || !version || !(registryTarball(match[1], version) || inRegistry(match[1], version))) { process.stderr.write(`fake npm: cannot install ${spec}\n`); process.exit(1); }
    [name, saved] = [match[1], version];
  }
  pkg.dependencies = { ...pkg.dependencies, [name]: saved };
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
const scope = join(cwd, 'node_modules', '@jimhoyd');
mkdirSync(scope, { recursive: true });
/** Where a dependency comes from: a tarball to unpack (with its lock `resolved`), or a directory to link. */
const source = (name, spec) => {
  if (spec.startsWith('file:') && spec.endsWith('.tgz')) return { tarball: spec.slice(5), resolved: spec };
  if (spec.startsWith('file:')) return { dir: spec.slice(5) };
  const tarball = registryTarball(name, spec);
  if (tarball) return { tarball, resolved: `${tarballBase}${plus(name)}@${spec}.tgz` };
  const dir = inRegistry(name, spec);
  return dir ? { dir } : undefined;
};
for (const name of readdirSync(scope)) { rmSync(join(scope, name), { recursive: true, force: true }); }
// Links outside @jimhoyd that the site no longer depends on are pruned too.
for (const entry of readdirSync(join(cwd, 'node_modules')).filter(name => name.startsWith('@') && name !== '@jimhoyd'))
  for (const name of readdirSync(join(cwd, 'node_modules', entry))) if (!Object.hasOwn(pkg.dependencies ?? {}, `${entry}/${name}`)) rmSync(join(cwd, 'node_modules', entry, name), { recursive: true, force: true });
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) if (!source(name, spec) && registry) { process.stderr.write(`fake npm: no ${name}@${spec}\n`); process.exit(1); }
const packages = { '': { name: pkg.name, dependencies: pkg.dependencies } };
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bin'];
const peers = [];
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  const from = source(name, spec);
  if (!from) continue;
  let manifest;
  if (from.tarball) {
    const integrity = integrityOf(from.tarball);
    unpack(from.tarball, name, previousLock[`node_modules/${name}`]?.integrity);
    manifest = JSON.parse(readFileSync(join(cwd, 'node_modules', name, 'package.json'), 'utf8'));
    packages[`node_modules/${name}`] = { version: manifest.version, resolved: from.resolved, integrity };
    const bundled = join(cwd, 'node_modules', name, 'node_modules');
    if (existsSync(bundled)) for (const entry of readdirSync(bundled)) for (const inner of entry.startsWith('@') ? readdirSync(join(bundled, entry)).map(child => `${entry}/${child}`) : [entry]) {
      const version = JSON.parse(readFileSync(join(bundled, inner, 'package.json'), 'utf8')).version;
      packages[`node_modules/${name}/node_modules/${inner}`] = { version, inBundle: true };
    }
  } else {
    link(from.dir, name);
    manifest = JSON.parse(readFileSync(join(from.dir, 'package.json'), 'utf8'));
    packages[`node_modules/${name}`] = { version: manifest.version, resolved: spec.startsWith('file:') ? from.dir : `https://registry.example/${name}/-/${spec}.tgz`, link: spec.startsWith('file:') };
  }
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
