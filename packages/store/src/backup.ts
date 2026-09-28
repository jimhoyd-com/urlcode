// Online backup of the store database (#859): a consistent copy through SQLite's own backup API, safe to take while
// the server keeps serving, written to a new private file and checked before it appears at its destination.
import { link, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION, patched } from './database.ts';

export interface StoreBackupOptions {
  /** Absolute path of the live store database (the host's `database`, `STORE_DATABASE` or `data/store.sqlite`). */
  database: string;
  /** Absolute path of the new backup file; it must not exist. */
  destination: string;
}
export interface StoreBackupResult {
  format: 'urlcode-store-sqlite';
  /** The copy's `user_version`: the store schema version a restore needs this release (or a later one) to open. */
  schemaVersion: number;
  bytes: number;
  destination: string;
}

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const pragma = (db: sqlite.DatabaseSync, name: string): number => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]);

/** The copy is a store database of the source's version and passes SQLite's own integrity check. */
function verify(file: string, schemaVersion: number): void {
  const copy = new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    copy.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    if (pragma(copy, 'application_id') !== STORE_APPLICATION_ID || pragma(copy, 'user_version') !== schemaVersion) throw new Error('The backup is not a store database of the source\'s schema version');
    const integrity = copy.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('The backup failed SQLite\'s integrity check');
  } finally { copy.close(); }
}

/**
 * Copies the store database with node:sqlite's online `backup()`: every committed transaction, including pages still
 * in the WAL, without stopping the server (whose writes wait only for the moment each step reads). Refuses a source
 * that is not a private store database of a schema this release understands and an existing destination. The copy is
 * written 0600 inside a private temporary directory beside the destination, verified (identity pragmas and
 * `integrity_check`), flushed, and then hard-linked into place, which fails rather than replace anything that appeared
 * there meanwhile. It never copies the live file byte by byte.
 */
export async function backupStore(options: StoreBackupOptions): Promise<StoreBackupResult> {
  if (typeof sqlite.backup !== 'function') throw new Error(`Backup needs node:sqlite backup() (Node 22.16 or newer); this is Node ${process.versions.node}`);
  if (!patched(process.versions.sqlite || '')) throw new Error(`The store requires a patched SQLite (3.44.6, 3.50.7, 3.51.3 or newer); this Node has ${process.versions.sqlite || 'none'}`);
  if (!isAbsolute(options.database) || !isAbsolute(options.destination)) throw new Error('--database and --destination must be absolute paths');
  // The directory is resolved, the file itself is not: a symlinked database is refused, as the store refuses it.
  let source: string, info: Awaited<ReturnType<typeof lstat>>;
  try { source = join(await realpath(dirname(options.database)), basename(options.database)); info = await lstat(source); }
  catch (error) { if (missing(error)) throw new Error('The store database does not exist', { cause: error }); throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new Error('The store database must be a private regular file (mode 0600, one link)');
  let parent: string;
  try { parent = await realpath(dirname(options.destination)); } catch (error) { if (missing(error)) throw new Error('The backup destination\'s directory does not exist', { cause: error }); throw error; }
  const destination = join(parent, basename(options.destination));
  if (destination === source) throw new Error('The backup cannot replace its source');
  try { await lstat(destination); throw new Error('The backup destination already exists'); } catch (error) { if (!missing(error)) throw error; }

  const live = new sqlite.DatabaseSync(source, { readOnly: true, allowExtension: false });
  const temporary = await mkdtemp(join(parent, '.urlcode-store-backup-')), file = join(temporary, 'store.sqlite');
  try {
    live.exec('PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const schemaVersion = pragma(live, 'user_version');
    if (pragma(live, 'application_id') !== STORE_APPLICATION_ID || schemaVersion < 1) throw new Error('Not a store database');
    if (schemaVersion > STORE_SCHEMA_VERSION) throw new Error(`The store database has schema version ${schemaVersion}; this release supports up to ${STORE_SCHEMA_VERSION}`);
    // Created first, 0600, so SQLite writes into a file only the operator can read (it keeps an existing file's mode).
    await (await open(file, 'wx', 0o600)).close();
    await sqlite.backup(live, file, { rate: 256 });
    verify(file, schemaVersion);
    const copied = await lstat(file);
    // Windows FlushFileBuffers needs a writable handle.
    const handle = await open(file, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await link(file, destination);
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { format: 'urlcode-store-sqlite', schemaVersion, bytes: copied.size, destination };
  } finally {
    live.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}
