// One serving process per database, for the bundled extensions' own SQLite files (store, auth). A process
// that serves a database first holds an exclusive lock on the file `<database>.server-lock` beside it, which the
// operating system drops when the process ends, however it ends. A second serving process is refused before it writes.
// The operator commands never take it: they share the database through SQLite's own locking, as before. A site
// that needs several servers keeps its data in a database server through its own library or an independent extension
// (docs/EXTENSIONS.md, owner choice). Locks are unreliable over a network filesystem, so a Linux database directory on
// one is refused first.
import { closeSync, openSync, realpathSync } from 'node:fs';
import { mkdir, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** What the network filesystem check reads from the machine. `hostProbe` is the real one; tests pass a fake. */
export interface HostProbe {
  platform: NodeJS.Platform;
  statfs(path: string): Promise<{ type: number | bigint }>;
}
export const hostProbe: HostProbe = { platform: process.platform, statfs: path => statfs(path) };

/**
 * Linux `statfs` `f_type` magic numbers (linux/magic.h, fs/smb/client) of filesystems whose files another host can
 * open: SQLite says WAL does not work over a network filesystem, and `fcntl` locks over them are unreliable.
 */
export const NETWORK_FILESYSTEMS: ReadonlyMap<number, string> = new Map([
  [0x6969, 'NFS'], // NFS_SUPER_MAGIC
  [0x517b, 'SMB'], // SMB_SUPER_MAGIC
  [0xfe534d42, 'SMB2'], // SMB2_SUPER_MAGIC
  [0xff534d42, 'CIFS'], // CIFS_SUPER_MAGIC
  [0x65735546, 'FUSE'], // FUSE_SUPER_MAGIC (sshfs, s3fs, gcsfuse, and Docker Desktop's gRPC FUSE file sharing)
  [0x01021997, '9P'], // V9FS_MAGIC (WSL2's /mnt drives, some VM shares)
  [0x00c36400, 'Ceph'], // CEPH_SUPER_MAGIC
  [0x5346414f, 'AFS'], // AFS_SUPER_MAGIC
]);

/**
 * Refuses a database directory on a network filesystem (`NETWORK_FILESYSTEMS`); `what` names the database in the error
 * ("The store database is on an NFS filesystem"). Linux only: macOS and Windows expose no filesystem type a check can
 * trust through Node, so there it is skipped. Fields the probe leaves out are the real machine's.
 */
export async function refuseNetworkFilesystem(directory: string, what: string, probe: Partial<HostProbe> = hostProbe): Promise<void> {
  const machine = { ...hostProbe, ...probe };
  if (machine.platform !== 'linux') return;
  // `f_type` is a signed long in the kernel's ABI; the magic numbers are unsigned 32-bit values.
  const type = Number((await machine.statfs(directory)).type) >>> 0, name = NETWORK_FILESYSTEMS.get(type);
  if (name) throw new Error(`The ${what} database is on a ${name} filesystem (statfs type 0x${type.toString(16)}); SQLite needs it on local disk. Move it to a local filesystem.`);
}

/** A serving process's hold on its database's server lock. `release` drops this holder's share of it. */
export interface ServerLock { readonly path: string; release(): void }

/**
 * The locks this process holds, by lock file, with how many holders share each: a dev reload activates the next
 * runtime before it closes the previous one, and both hold the one lock. Kept on `globalThis` under a `Symbol.for` key,
 * so a second copy of core in the process shares it.
 */
const LOCKS = Symbol.for('urlcode.serverLocks');
function held(): Map<string, { db: DatabaseSync; refs: number }> {
  const slot = globalThis as Record<symbol, unknown>;
  return (slot[LOCKS] ??= new Map()) as Map<string, { db: DatabaseSync; refs: number }>;
}
/** The lock file of `database`: `<database>.server-lock` in the database's real directory. It is never deleted. */
export function serverLockPath(database: string): string {
  const requested = resolve(database);
  let directory = dirname(requested);
  try { directory = realpathSync(directory); } catch { /* Not created yet: nothing can hold it. */ }
  return join(directory, `${basename(requested)}.server-lock`);
}
const busy = (error: unknown): boolean => (error as { errcode?: unknown }).errcode === 5; // SQLITE_BUSY

/**
 * Takes `database`'s server lock for this process, or throws when another process holds it. Creates the database's
 * directory (0700) when absent and refuses it on a Linux network filesystem first. The lock is SQLite's own file lock
 * (`fcntl` on POSIX, `LockFileEx` on Windows) on the lock file, held as an exclusive transaction that never ends: no
 * heartbeat, timestamp or host name is involved, and the operating system releases it when the process exits or is
 * killed (on Windows after a delay the OS decides, so a restart straight after a crash can be refused once). A holder
 * in this process shares it. `probe` is a test seam.
 */
export async function holdServerLock(database: string, what: string, probe?: Partial<HostProbe>): Promise<ServerLock> {
  const directory = dirname(resolve(database));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await refuseNetworkFilesystem(directory, what, probe);
  const path = serverLockPath(database), locks = held();
  let entry = locks.get(path);
  if (!entry) {
    closeSync(openSync(path, 'a', 0o600));
    const db = new DatabaseSync(path, { allowExtension: false });
    try {
      // The wait covers an operator command's momentary look at the lock (`serverLockHeld`), never a serving holder.
      db.exec('PRAGMA busy_timeout=500; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    } catch (error) {
      db.close();
      if (busy(error)) throw new Error(`Another process is already serving this ${what} database (${resolve(database)}): the bundled ${what} serves its database from one process. Stop that server first, or, to run several servers, keep the data in a database server through your own library or an independent extension.`, { cause: error });
      throw error;
    }
    entry = { db, refs: 0 };
    locks.set(path, entry);
  }
  entry.refs++;
  const holding = entry;
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      if (--holding.refs > 0) return;
      locks.delete(path);
      holding.db.close();
    },
  };
}

/**
 * Whether a serving process (this one or another) holds `database`'s server lock now. An operator command asks before
 * it writes with a declaration the server may not share. It only reads: a moment's shared lock on the lock file, which
 * fails at once while a server holds it exclusively.
 */
export function serverLockHeld(database: string): boolean {
  const path = serverLockPath(database);
  if (held().has(path)) return true;
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, allowExtension: false }); } catch { return false; } // No lock file: never served.
  try { db.prepare('SELECT count(*) AS n FROM sqlite_master').get(); return false; }
  catch (error) { if (busy(error)) return true; throw error; }
  finally { db.close(); }
}

/** SQLITE_BUSY, or one of its extended codes (`busy` above matches the primary code only, as the server lock needs). */
const busyOrExtended = (error: unknown): boolean => {
  const code = error !== null && typeof error === 'object' && 'errcode' in error ? error.errcode : undefined;
  return typeof code === 'number' && (code & 0xff) === 5;
};
/**
 * An operator connection's write lock beside a serving process: runs `begin` (which issues `BEGIN IMMEDIATE`) and,
 * while it fails with SQLITE_BUSY, retries it every millisecond until `waitMs` has passed, then rethrows SQLite's error
 * unchanged. SQLite's busy handler sleeps up to 100 ms between attempts and is not a queue: beside a server that holds
 * the write lock for most of each commit (a flush to a slow disk, such as FlushFileBuffers on Windows) with only a
 * short idle gap between commits, its roughly 30 attempts in 2 seconds can all land on a held lock, and the command
 * failed with "database is locked". Polling sees such a gap; a lock that is really held (a stuck process), or a writer
 * that leaves no idle gap at all, still fails once `waitMs` has passed. The connection's busy timeout is 0 while
 * polling and `waitMs` afterwards, so open an operator connection with that timeout.
 */
export function beginImmediateWithin<T>(db: DatabaseSync, waitMs: number, begin: () => T): T {
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  db.exec('PRAGMA busy_timeout=0');
  try {
    for (;;) {
      try { return begin(); }
      catch (error) {
        if (!busyOrExtended(error) || Date.now() >= deadline) throw error;
        Atomics.wait(pause, 0, 0, 1);
      }
    }
  } finally { db.exec(`PRAGMA busy_timeout=${waitMs}`); }
}
