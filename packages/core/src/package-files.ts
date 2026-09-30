import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddonKind } from './addon-manifest.ts';
import type { LockEntry } from './addon-install.ts';
import { ConfigError, assert } from './errors.ts';
import { isCode, isRecord } from './object-guards.ts';

/**
 * The per-file record of every installed add-on package (#857 item 2). npm keeps no tarball for a registry install,
 * only the lock's sha512 and the unpacked files, so `extensions add` and `artifacts add` write the sha256 of each file
 * they installed to `addon-files.lock.json` at the site root: beside `package-lock.json`, committed and reviewed with
 * it, outside `node_modules` (which it describes) and outside `app/` (so it is not part of the project revision).
 * `list --strict`, `artifacts inspect` and `verify` compare the installed files with it offline. The record is only as
 * trustworthy as the moment it was written: it catches a later edit, not a package that was bad when installed.
 */
export const ADDON_FILES_LOCK = 'addon-files.lock.json';
const packageFileLimits = {
  /** Most files hashed in one installed package. */
  maxFiles: 20000,
  /** Most bytes hashed in one installed package. */
  maxBytes: 512 * 1024 * 1024,
  /** Paths listed per category (added, removed, changed) in a report; the rest are counted. */
  maxListed: 20,
} as const;

export interface RecordedPackage {
  /** The add-on name its descriptor declares. */
  name: string; kind: AddonKind;
  /** The npm spec the operator added an independent package with; null for a catalog add-on (core's pin). */
  spec: string | null;
  version: string | null; integrity: string | null; resolved: string | null;
  /** A linked directory (a development or `file:` directory install): not hashed, its files change with its source. */
  linked?: true;
  /** Package-relative path (POSIX) -> lowercase hex sha256, or `symlink:<target>`. Nested `node_modules` excluded. */
  files: Record<string, string>;
}
export interface AddonFilesLock { lockfileVersion: 1; packages: Record<string, RecordedPackage> }

export async function readFilesLock(site: string): Promise<AddonFilesLock> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(site, ADDON_FILES_LOCK), 'utf8')); }
  catch (error) { if (isCode(error, 'ENOENT')) return { lockfileVersion: 1, packages: {} }; throw new ConfigError(`${ADDON_FILES_LOCK} is not valid JSON; restore it from version control`); }
  assert(isRecord(raw) && raw.lockfileVersion === 1 && isRecord(raw.packages), `${ADDON_FILES_LOCK} is not a lockfileVersion 1 add-on file lock; restore it from version control`);
  for (const [pkg, entry] of Object.entries(raw.packages)) {
    assert(isRecord(entry) && typeof entry.name === 'string' && (entry.kind === 'extension' || entry.kind === 'artifact') && isRecord(entry.files) && Object.values(entry.files).every(value => typeof value === 'string'), `${ADDON_FILES_LOCK} entry ${pkg} is malformed; restore it from version control`);
  }
  return raw as unknown as AddonFilesLock;
}
/** Writes the lock with sorted packages and files; an empty lock removes the file. */
export async function writeFilesLock(site: string, lock: AddonFilesLock): Promise<void> {
  const path = join(site, ADDON_FILES_LOCK), names = Object.keys(lock.packages).sort();
  if (!names.length) { await rm(path, { force: true }); return; }
  const packages = Object.fromEntries(names.map(name => {
    const entry = lock.packages[name]!;
    return [name, { ...entry, files: Object.fromEntries(Object.keys(entry.files).sort().map(file => [file, entry.files[file]!])) }];
  }));
  await writeFile(path, JSON.stringify({ lockfileVersion: 1, packages }, null, 2) + '\n');
}

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};
/** The sha256 of every file in an installed package directory, by POSIX relative path; its own `node_modules` is skipped. */
async function hashPackageFiles(directory: string): Promise<Record<string, string>> {
  const root = await realpath(directory), files: Record<string, string> = {};
  let count = 0, bytes = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(dir, entry.name), rel = prefix + entry.name;
      if (!prefix && entry.name === 'node_modules') continue;
      if (++count > packageFileLimits.maxFiles) throw new ConfigError(`${directory} holds more than ${packageFileLimits.maxFiles} files; too many to record`);
      if (entry.isSymbolicLink()) files[rel] = `symlink:${await readlink(path)}`;
      else if (entry.isDirectory()) await walk(path, `${rel}/`);
      else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
        if (bytes > packageFileLimits.maxBytes) throw new ConfigError(`${directory} holds more than ${packageFileLimits.maxBytes} bytes; too much to record`);
        files[rel] = await sha256File(path);
      } else files[rel] = 'special';
    }
  };
  await walk(root, '');
  return files;
}

export interface Drift { added: string[]; removed: string[]; changed: string[]; counts: { added: number; removed: number; changed: number } }
/** How `actual` differs from `expected`, each category sorted and listed up to `maxListed`. */
function compareFiles(expected: Record<string, string>, actual: Record<string, string>): Drift {
  const added = Object.keys(actual).filter(path => !Object.hasOwn(expected, path)).sort();
  const removed = Object.keys(expected).filter(path => !Object.hasOwn(actual, path)).sort();
  const changed = Object.keys(expected).filter(path => Object.hasOwn(actual, path) && actual[path] !== expected[path]).sort();
  return { added: added.slice(0, packageFileLimits.maxListed), removed: removed.slice(0, packageFileLimits.maxListed), changed: changed.slice(0, packageFileLimits.maxListed), counts: { added: added.length, removed: removed.length, changed: changed.length } };
}
const drifted = (drift: Drift): boolean => drift.counts.added + drift.counts.removed + drift.counts.changed > 0;
export function describeDrift(drift: Drift): string {
  const part = (label: string, list: string[], count: number): string[] => count ? [`${label} ${list.join(', ')}${count > list.length ? ` and ${count - list.length} more` : ''}`] : [];
  return [...part('changed', drift.changed, drift.counts.changed), ...part('added', drift.added, drift.counts.added), ...part('removed', drift.removed, drift.counts.removed)].join('; ');
}

/** What an installed package's lock entry and files look like now, for the record `add` writes. */
export async function recordPackage(site: string, pkg: string, entry: LockEntry | undefined, identity: { name: string; kind: AddonKind; spec: string | null }): Promise<RecordedPackage> {
  const base = { ...identity, version: entry?.version ?? null, integrity: entry?.integrity ?? null, resolved: entry?.resolved ?? null };
  if (entry?.link) return { ...base, linked: true, files: {} };
  return { ...base, files: await hashPackageFiles(join(site, 'node_modules', pkg)) };
}

/**
 * `match`: the files are exactly those recorded. `modified`: a file was added, removed or changed since. `stale`:
 * package-lock.json no longer locks what was recorded (npm moved it outside `urlcode … add`). `unrecorded`: no record.
 * `linked`: a linked directory, not hashed. `missing`: not installed (reported elsewhere).
 */
export interface FileCheck { status: 'match' | 'modified' | 'stale' | 'unrecorded' | 'linked' | 'missing'; recorded: number; drift?: Drift; message?: string }
export async function checkPackageFiles(site: string, pkg: string, entry: LockEntry | undefined, recorded: RecordedPackage | undefined, kind: AddonKind): Promise<FileCheck> {
  const noun = kind === 'extension' ? 'extensions' : 'artifacts';
  try { await lstat(join(site, 'node_modules', pkg)); } catch (error) { if (isCode(error, 'ENOENT')) return { status: 'missing', recorded: 0 }; throw error; }
  if (!recorded) return entry?.link ? { status: 'linked', recorded: 0 } : { status: 'unrecorded', recorded: 0, message: `${pkg} has no entry in ${ADDON_FILES_LOCK}, so its installed files cannot be checked; run \`urlcode ${noun} add\` with it again to record them` };
  if (Boolean(entry?.link) !== Boolean(recorded.linked) || (entry?.integrity ?? null) !== recorded.integrity || (entry?.version ?? null) !== recorded.version) {
    return { status: 'stale', recorded: Object.keys(recorded.files).length, message: `package-lock.json locks ${pkg} ${entry?.version ?? '(no version)'} ${entry?.integrity ?? (entry?.link ? '(linked)' : '(no integrity)')}, but ${ADDON_FILES_LOCK} recorded ${recorded.version ?? '(no version)'} ${recorded.integrity ?? (recorded.linked ? '(linked)' : '(no integrity)')}: it was changed outside \`urlcode ${noun} add\`; add it again with \`urlcode ${noun} add\` so it passes the install checks` };
  }
  if (recorded.linked) return { status: 'linked', recorded: 0 };
  const drift = compareFiles(recorded.files, await hashPackageFiles(join(site, 'node_modules', pkg)));
  if (!drifted(drift)) return { status: 'match', recorded: Object.keys(recorded.files).length };
  return { status: 'modified', recorded: Object.keys(recorded.files).length, drift, message: `${pkg}'s installed files differ from ${ADDON_FILES_LOCK} (${describeDrift(drift)}); reinstall with \`npm ci --ignore-scripts\`` };
}

/** The highest of npm version strings by semver precedence (a prerelease sorts below its release); unparsable ones last. */
export function newestVersion(versions: readonly string[]): string | undefined {
  const parse = (version: string): [number[], string[] | undefined] | undefined => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
    return match ? [[Number(match[1]), Number(match[2]), Number(match[3])], match[4]?.split('.')] : undefined;
  };
  const compare = (a: string, b: string): number => {
    const x = parse(a), y = parse(b);
    if (!x || !y) return x ? 1 : y ? -1 : 0;
    for (let index = 0; index < 3; index++) if (x[0][index] !== y[0][index]) return x[0][index]! - y[0][index]!;
    if (!x[1] || !y[1]) return x[1] ? -1 : y[1] ? 1 : 0;
    for (let index = 0; index < Math.max(x[1].length, y[1].length); index++) {
      const p = x[1][index], q = y[1][index];
      if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
      if (p === q) continue;
      const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
      return numeric ? Number(p) - Number(q) : /^\d+$/.test(p) ? -1 : /^\d+$/.test(q) ? 1 : p < q ? -1 : 1;
    }
    return 0;
  };
  return [...versions].sort(compare).at(-1);
}

/** The package name of a registry spec (`name`, `name@range`, `@scope/name@range`), or undefined for a path, URL or git spec. */
export function registrySpecName(spec: string): string | undefined {
  const match = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([^\s/:]+))?$/i.exec(spec);
  return match && !spec.endsWith('.tgz') && !spec.endsWith('.tar.gz') ? match[1] : undefined;
}
