import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, assert } from './errors.ts';
import { isRecord as record } from './object-guards.ts';

/**
 * Exact dependency pins for a generated application.
 *
 * `urlcode init --with` resolves whatever `@jimhoyd/urlcode-<name>` packages are already installed beside the
 * invoking directory. Without a manifest the generated site records nothing about which versions it was built
 * against, so a later `npm install @jimhoyd/urlcode-auth` in that site can resolve a different set (#212). This
 * module reads the versions that were actually resolved, validates the whole set against the packages' own
 * declared `peerDependencies`, and renders a `package.json` pinning every one of them exactly.
 *
 * It never runs a package manager: generating a lockfile stays an explicit `npm install` the operator runs after
 * reviewing the manifest. It also never imports an extension implementation -- only package metadata is read, by
 * a name the caller supplied -- so core's generic extension boundary is unchanged.
 */

export const CORE_PACKAGE = '@jimhoyd/urlcode';
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

interface Version { major: number; minor: number; patch: number; pre: readonly (string | number)[] }
const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): Version | null {
  const match = versionPattern.exec(value.trim());
  if (!match) return null;
  const pre = match[4] === undefined ? [] : match[4].split('.').map(part => /^\d+$/.test(part) ? Number(part) : part);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre };
}
function comparePre(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  // A version with a prerelease is lower than the same version without one.
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index], right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
    if (typeof left === 'number') return -1; // numeric identifiers rank lower than alphanumeric ones
    if (typeof right === 'number') return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  return comparePre(a.pre, b.pre);
}
interface Comparator { operator: '>' | '>=' | '<' | '<=' | '='; version: Version }
/**
 * A deliberately small subset of the range grammar: `*`, exact versions, the comparators, `^` and `~` over a
 * complete `x.y.z`, whitespace for AND and `||` for OR. Anything else refuses rather than guessing, so an
 * unrecognized peer range surfaces as a refusal instead of a silently wrong compatibility answer.
 */
function parseComparatorSet(text: string, context: string): Comparator[] | 'any' {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.every(token => token === '*' || token === 'x' || token === 'X')) return 'any';
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
    const version = match ? parseVersion(match[2]!) : null;
    if (!match || !version) throw new ConfigError(`Unsupported version range ${JSON.stringify(text)} (${context}); supported forms are *, x.y.z, >=, >, <, <=, = and ^ or ~ over a complete x.y.z`);
    const operator = (match[1] ?? '=') as Comparator['operator'] | '^' | '~';
    if (operator === '^' || operator === '~') {
      // ^0.x is minor-bounded, ^0.0.x is patch-bounded, ^x is major-bounded; ~ is always minor-bounded.
      const upper = operator === '~' || version.major === 0
        ? (operator === '^' && version.major === 0 && version.minor === 0
          ? { major: 0, minor: 0, patch: version.patch + 1, pre: [] }
          : { major: version.major, minor: version.minor + 1, patch: 0, pre: [] })
        : { major: version.major + 1, minor: 0, patch: 0, pre: [] };
      comparators.push({ operator: '>=', version }, { operator: '<', version: upper });
      continue;
    }
    comparators.push({ operator, version });
  }
  return comparators;
}
function satisfiesComparators(version: Version, comparators: Comparator[]): boolean {
  // npm's prerelease rule: a prerelease version only satisfies a set that itself names a prerelease of the same
  // x.y.z, so 0.5.0-alpha.1 never slips past `<0.5.0`.
  if (version.pre.length && !comparators.some(item => item.version.pre.length && item.version.major === version.major && item.version.minor === version.minor && item.version.patch === version.patch)) return false;
  return comparators.every(item => {
    const order = compareVersions(version, item.version);
    switch (item.operator) {
      case '>': return order > 0;
      case '>=': return order >= 0;
      case '<': return order < 0;
      case '<=': return order <= 0;
      default: return order === 0;
    }
  });
}
export function satisfiesRange(version: string, range: string, context = 'peer range'): boolean {
  const parsed = parseVersion(version);
  if (!parsed) throw new ConfigError(`Unsupported version ${JSON.stringify(version)} (${context})`);
  return range.split('||').some(part => {
    const set = parseComparatorSet(part, context);
    return set === 'any' || satisfiesComparators(parsed, set);
  });
}

export interface InstalledPackage {
  name: string; version: string; directory: string;
  peers: Record<string, string>; optionalPeers: ReadonlySet<string>; node: string | undefined;
}
interface RawManifest { name?: unknown; version?: unknown; peerDependencies?: unknown; peerDependenciesMeta?: unknown; engines?: unknown }
const strings = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (record(value)) for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out[key] = item;
  return out;
};
async function readManifest(file: string): Promise<InstalledPackage | null> {
  let parsed: RawManifest;
  try { parsed = JSON.parse(await readFile(file, 'utf8')) as RawManifest; }
  catch { return null; }
  if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') return null;
  const optional = new Set<string>();
  if (record(parsed.peerDependenciesMeta)) for (const [key, value] of Object.entries(parsed.peerDependenciesMeta)) if (record(value) && value.optional === true) optional.add(key);
  const engines = record(parsed.engines) && typeof parsed.engines.node === 'string' ? parsed.engines.node : undefined;
  return { name: parsed.name, version: parsed.version, directory: dirname(file), peers: strings(parsed.peerDependencies), optionalPeers: optional, node: engines };
}
/**
 * Walks `node_modules` upwards from the invoking directory, exactly like Node's own resolution but reading the
 * package's manifest rather than its entry point. Reading the manifest directly (instead of resolving the entry)
 * means a package whose `exports` does not expose `./package.json` is still inspectable, and nothing in the
 * package is loaded or executed.
 */
export async function findInstalledPackage(name: string, from: string): Promise<InstalledPackage | null> {
  assert(namePattern.test(name), `Invalid package name: ${name}`);
  let directory = resolve(from);
  for (;;) {
    const found = await readManifest(join(directory, 'node_modules', ...name.split('/'), 'package.json'));
    if (found && found.name === name) return found;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
/** The version of the runtime executing this command; that is the version a generated site is pinned to. */
export async function runningCore(): Promise<InstalledPackage> {
  const file = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const manifest = await readManifest(file);
  assert(manifest && manifest.name === CORE_PACKAGE, `Could not read the running runtime manifest at ${file}`);
  return manifest;
}

/**
 * `resolved`/`link` entries from npm's hidden lockfile, used only to notice that a package was installed from a
 * local directory or tarball. Such a package's version number is not installable from a registry, so the manifest
 * has to record the local specifier instead of the exact version for the site to install offline.
 */
async function localSpecifiers(cwd: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(join(cwd, 'node_modules', '.package-lock.json'), 'utf8')); }
  catch { return out; }
  if (!record(parsed) || !record(parsed.packages)) return out;
  for (const [key, value] of Object.entries(parsed.packages)) {
    const index = key.lastIndexOf('node_modules/');
    if (index !== 0 || !record(value)) continue; // nested installs belong to another package's tree
    const name = key.slice('node_modules/'.length);
    const resolvedTo = typeof value.resolved === 'string' ? value.resolved : '';
    if (value.link === true) { if (resolvedTo) out.set(name, 'file:' + resolve(cwd, resolvedTo)); continue; }
    if (resolvedTo.startsWith('file:')) out.set(name, 'file:' + resolve(cwd, resolvedTo.slice('file:'.length)));
  }
  return out;
}

export interface DependencyPin {
  name: string; version: string; specifier: string;
  /** True when the specifier is a local path or tarball rather than a registry version. */
  local: boolean;
  /** `runtime` is core, `extension` was named in --with, `peer` was pulled in by a package's peerDependencies. */
  role: 'runtime' | 'extension' | 'peer';
}
export interface DependencySet {
  pins: DependencyPin[];
  /** Exactly what goes into the generated `dependencies` block, sorted by name. */
  dependencies: Record<string, string>;
  /** Highest recognized `engines.node` floor across the set, or undefined when none was expressed as `>=x.y.z`. */
  node: string | undefined;
  /** True when any pin points at a local path or tarball. */
  local: boolean;
}
export interface DependencyOptions {
  cwd?: string | undefined;
  /** `--pin <package>=<specifier>`: an operator-chosen specifier, for local tarballs and mirrors. */
  overrides?: ReadonlyMap<string, string> | undefined;
}
export function parsePin(value: string): [string, string] {
  const index = value.indexOf('=');
  assert(index > 0, 'Use --pin <package>=<specifier>, for example --pin @jimhoyd/urlcode-auth=file:/abs/path/urlcode-auth.tgz');
  const name = value.slice(0, index).trim(), specifier = value.slice(index + 1).trim();
  assert(namePattern.test(name), `Invalid --pin package name: ${name}`);
  assert(specifier.length > 0 && specifier.length <= 512 && !/[\s\0]/.test(specifier), `Invalid --pin specifier for ${name}`);
  return [name, specifier];
}
function nodeFloor(ranges: readonly (string | undefined)[]): string | undefined {
  let best: Version | undefined;
  for (const range of ranges) {
    // Only a plain `>=x.y.z` floor is recognized; anything else is left out rather than reinterpreted.
    const match = range === undefined ? null : /^>=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range.trim());
    const version = match ? parseVersion(match[1]!) : null;
    if (version && (!best || compareVersions(version, best) > 0)) best = version;
  }
  return best ? `>=${best.major}.${best.minor}.${best.patch}${best.pre.length ? '-' + best.pre.join('.') : ''}` : undefined;
}

/**
 * Resolves core plus every named extension and their declared peers, then validates the whole set against every
 * declared peer range before returning. Compatibility is judged as a set: a mismatch anywhere refuses, listing
 * every mismatch rather than the first.
 */
export async function collectDependencySet(names: readonly string[], packageNames: readonly string[], { cwd = process.cwd(), overrides }: DependencyOptions = {}): Promise<DependencySet> {
  assert(names.length === packageNames.length, 'Each extension name needs its package name');
  const core = await runningCore();
  const resolved = new Map<string, InstalledPackage>([[CORE_PACKAGE, core]]);
  const roles = new Map<string, DependencyPin['role']>([[CORE_PACKAGE, 'runtime']]);
  const missing: string[] = [];
  const pending: string[] = [];
  for (const pkg of packageNames) { roles.set(pkg, 'extension'); pending.push(pkg); }
  // A copy of core installed beside the project would be resolved by the generated site, not the one running
  // here; pinning one version while the other is installed is exactly the inconsistency this refuses to record.
  const installedCore = await findInstalledPackage(CORE_PACKAGE, cwd);
  if (installedCore && installedCore.version !== core.version)
    throw new ConfigError(`${CORE_PACKAGE} ${installedCore.version} is installed in ${cwd} but this command is ${core.version}; run the matching CLI or align the installed runtime before recording pins`);
  while (pending.length) {
    const name = pending.shift()!;
    if (resolved.has(name)) continue;
    const found = await findInstalledPackage(name, cwd);
    if (!found) { missing.push(name); continue; }
    resolved.set(name, found);
    for (const peer of Object.keys(found.peers)) {
      if (resolved.has(peer) || found.optionalPeers.has(peer)) continue;
      if (!roles.has(peer)) roles.set(peer, 'peer');
      pending.push(peer);
    }
  }
  if (missing.length) {
    const required = missing.map(name => {
      const source = [...resolved.values()].find(pkg => Object.hasOwn(pkg.peers, name));
      return source ? `${name} (required by ${source.name} ${source.peers[name]})` : name;
    });
    throw new ConfigError(`Cannot record exact pins: ${required.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not installed in ${cwd}. Install the missing package(s) there, or pass --no-manifest to generate the site without a dependency manifest.`);
  }
  const conflicts: string[] = [];
  for (const pkg of resolved.values())
    for (const [peer, range] of Object.entries(pkg.peers)) {
      const installed = resolved.get(peer);
      if (!installed) continue; // optional peer that is not installed
      if (!satisfiesRange(installed.version, range, `${pkg.name} peerDependencies.${peer}`)) conflicts.push(`${pkg.name} ${pkg.version} requires ${peer} ${range}, but ${installed.version} is installed`);
    }
  if (conflicts.length) throw new ConfigError(`Incompatible versions: ${conflicts.join('; ')}`);
  const locals = await localSpecifiers(cwd);
  const pins: DependencyPin[] = [...resolved.values()]
    .map(pkg => {
      const override = overrides?.get(pkg.name);
      const local = locals.get(pkg.name);
      const specifier = override ?? local ?? pkg.version;
      return { name: pkg.name, version: pkg.version, specifier, local: specifier !== pkg.version, role: roles.get(pkg.name) ?? 'peer' };
    })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const [name] of overrides ?? []) assert(pins.some(pin => pin.name === name), `--pin ${name} names a package that is not part of this project's dependency set`);
  const dependencies: Record<string, string> = {};
  for (const pin of pins) dependencies[pin.name] = pin.specifier;
  return { pins, dependencies, node: nodeFloor([...resolved.values()].map(pkg => pkg.node)), local: pins.some(pin => pin.local) };
}

const TRIMMED = '._-';
const manifestName = (directory: string): string => {
  const mapped = (directory.split(/[\\/]/).pop() ?? 'urlcode-site').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  // Trimmed with indices rather than /^[._-]+|[-._]+$/: an anchored quantifier
  // over a repeated character is retried from every start position, which is
  // quadratic on a directory name of many dashes (CodeQL js/polynomial-redos).
  let start = 0, end = mapped.length;
  while (start < end && TRIMMED.includes(mapped[start] ?? '')) start += 1;
  while (end > start && TRIMMED.includes(mapped[end - 1] ?? '')) end -= 1;
  const base = mapped.slice(start, end);
  return base.length ? base.slice(0, 214) : 'urlcode-site';
};
/** The generated manifest: private, module type, exact pins, and nothing that runs a package manager. */
export function renderPackageManifest(directory: string, set: DependencySet): string {
  return JSON.stringify({
    name: manifestName(directory),
    private: true,
    version: '0.0.0',
    type: 'module',
    ...(set.node ? { engines: { node: set.node } } : {}),
    dependencies: set.dependencies,
  }, null, 2) + '\n';
}
/**
 * The install step is printed, never run: generating `package-lock.json` executes a package manager, which
 * resolves and downloads code, so it stays the operator's explicit action after reviewing the manifest.
 */
export function installSteps(directory: string, set: DependencySet): string[] {
  const where = isAbsolute(directory) ? directory : resolve(directory);
  return [
    `Review ${join(where, 'package.json')}; it pins ${set.pins.map(pin => `${pin.name}@${pin.version}`).join(', ')}.`,
    `Run \`npm install\` in ${where} to install those exact versions and generate package-lock.json${set.local ? ' (add `--offline` when the local paths are your only source)' : ''}. urlcode never runs a package manager for you.`,
  ];
}
