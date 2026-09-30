import { rmSync } from 'node:fs';
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The run-scoped temporary directories core creates (#977): a hermetic run's extension data (`hermetic`, seeded
 * databases) and the per-run `URLCODE_DATA_DIR` (`data`). Each is named `urlcode-<kind>-<pid>-XXXXXX` under the OS
 * temporary directory, so a later run can recognise one whose process is gone.
 *
 * Removal happens three ways: the owner's normal close (`removeRunDirectory`); a synchronous sweep of this process's
 * remaining directories on `exit`, which `process.exit` (the unhandled-rejection path, a signal handler) also runs;
 * and, for a process that could not run either (SIGKILL, a crash), `sweepStaleRunDirectories` at the next run.
 */
export type RunDirectoryKind = 'hermetic' | 'data';
/** A directory `createRunDirectory` made: the kind, the creating process id and mkdtemp's six-character suffix. */
export const runDirectoryPattern = /^urlcode-(?:hermetic|data)-([1-9][0-9]{0,9})-[A-Za-z0-9]{6}$/;
/**
 * A directory whose process is gone is swept only once neither it nor anything in it has been modified for this long.
 * The pid check is the real guard; the age covers a pid from another pid namespace sharing the temporary directory (a
 * container), which looks dead from here. A directory's own mtime changes only when an entry is added or removed, so
 * the age is that of its newest entry: a database written a minute ago keeps its directory (#977).
 */
export const staleRunDirectoryMs = 60 * 60 * 1000;
/**
 * How far the age check looks inside a candidate: at most this many entries, this many levels deep. A directory with
 * more, or one the check cannot read, is kept: leaving a stale directory is cheap, removing a live one is not.
 */
export const staleRunDirectoryScan = { entries: 1024, depth: 8 } as const;

const live = new Set<string>();
let exitHook = false;
let swept: Promise<unknown> | undefined;

function removeLiveSync(): void {
  for (const dir of live) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ } }
  live.clear();
}

/**
 * Creates a fresh, empty 0700 directory (its real path) for this run and tracks it until `removeRunDirectory`. The first call in a
 * process first sweeps stale directories an earlier, killed run left behind (best effort, never failing the run).
 */
export async function createRunDirectory(kind: RunDirectoryKind): Promise<string> {
  swept ??= sweepStaleRunDirectories().catch(() => []);
  await swept;
  const dir = await realpath(await mkdtemp(join(tmpdir(), `urlcode-${kind}-${process.pid}-`)));
  live.add(dir);
  if (!exitHook) { exitHook = true; process.on('exit', removeLiveSync); }
  return dir;
}

/** Removes a directory `createRunDirectory` made and stops tracking it. */
export async function removeRunDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  live.delete(dir);
}

/** Whether a process with this id exists (EPERM: it does, owned by someone else). */
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Whether nothing under `dir` (by `lstat`, never following a link) was modified since `cutoff`, within
 * `staleRunDirectoryScan`. Stops at the first recent entry; an unreadable entry or an exhausted budget is not stale.
 */
async function unmodifiedSince(dir: string, cutoff: number): Promise<boolean> {
  let budget: number = staleRunDirectoryScan.entries;
  const walk = async (path: string, depth: number): Promise<boolean> => {
    let names: string[];
    try { names = await readdir(path); } catch { return false; }
    for (const name of names) {
      if (--budget < 0) return false;
      const info = await lstat(join(path, name)).catch(() => undefined);
      if (!info || info.mtimeMs > cutoff) return false;
      if (info.isDirectory() && (depth >= staleRunDirectoryScan.depth || !await walk(join(path, name), depth + 1))) return false;
    }
    return true;
  };
  return walk(dir, 1);
}

export interface SweepOptions {
  /** The directory to sweep; the OS temporary directory by default. */
  root?: string;
  now?: number;
  maxAgeMs?: number;
  exists?: (pid: number) => boolean;
}

/**
 * Removes the run directories a killed process left behind and returns their paths. A candidate is only an entry of
 * `root` whose name matches `runDirectoryPattern` and that is, by `lstat` (never following a link), a real directory
 * owned by this user with mode 0700 (what mkdtemp creates), whose process is neither this one nor still running, and
 * which, with everything in it, was last modified at least `maxAgeMs` ago (`staleRunDirectoryScan` bounds the look
 * inside). Removal never follows a symbolic link, inside the directory either.
 */
export async function sweepStaleRunDirectories({ root = tmpdir(), now = Date.now(), maxAgeMs = staleRunDirectoryMs, exists = processExists }: SweepOptions = {}): Promise<string[]> {
  const removed: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  for (const name of await readdir(root)) {
    const match = runDirectoryPattern.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const path = join(root, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    if (uid !== undefined && (info.uid !== uid || (info.mode & 0o777) !== 0o700)) continue;
    if (now - info.mtimeMs < maxAgeMs || exists(pid) || !await unmodifiedSince(path, now - maxAgeMs)) continue;
    try { await rm(path, { recursive: true, force: true }); removed.push(path); } catch { /* another sweeper, or not ours to remove */ }
  }
  return removed;
}
