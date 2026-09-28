// The store's one SQLite database per site (#835): every collection's records, retained Idempotency-Key claims and
// undelivered audit events are rows in three shared tables, so a record write, its claim and its audit event commit
// in one transaction. Direct parameterized SQL through node:sqlite; no query builder. The schema only ever moves
// forward: an empty file is initialized to the newest version, an older store schema is upgraded step by step in
// one transaction each, and a newer or foreign one is refused before anything is served.
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';

/** PRAGMA application_id of a store database: "USTR". */
export const STORE_APPLICATION_ID = 0x55535452;
/**
 * Forward-only schema steps: `MIGRATIONS[n]` moves a database from `user_version` n to n + 1. A later version appends
 * a step and never edits a shipped one.
 */
const MIGRATIONS: readonly string[] = [
  // 0 -> 1. Records: one row per record of every collection. `seq` is creation order (an update keeps it), `owner` is
  // the principal on an owned collection (NULL on a shared one, or for a record written before the collection became
  // owned), `key` mirrors the declared unique key's value (NULL without one) so a lookup and the uniqueness check use
  // an index, and `data` is the JSON object of the declared fields.
  `CREATE TABLE store_records(seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, id TEXT NOT NULL,
     owner TEXT, key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'), UNIQUE(collection, id), UNIQUE(collection, key));
   CREATE INDEX store_records_order ON store_records(collection, seq);
   CREATE INDEX store_records_owner ON store_records(collection, owner, seq);
   CREATE TABLE store_idempotency(seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, key TEXT NOT NULL,
     claimed_at INTEGER NOT NULL, UNIQUE(collection, key));
   CREATE INDEX store_idempotency_order ON store_idempotency(collection, seq);
   CREATE TABLE store_audit_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, collection TEXT NOT NULL,
     at INTEGER NOT NULL, event TEXT NOT NULL CHECK (json_valid(event)));
   CREATE INDEX store_audit_outbox_order ON store_audit_outbox(at, seq);
   CREATE INDEX store_audit_outbox_collection ON store_audit_outbox(collection);`,
  // 1 -> 2. Result-aware Idempotency-Key replay: a claim keeps the request fingerprint (method, target and canonical
  // body, hashed) and the committed result (status and the record id), never record values. Version 1 claims carry
  // no fingerprint, so they cannot be replayed safely and are dropped: a retry of a version 1 request runs again.
  `DROP TABLE store_idempotency;
   CREATE TABLE store_idempotency(seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, key TEXT NOT NULL,
     fingerprint TEXT NOT NULL, status INTEGER NOT NULL, record_id TEXT, claimed_at INTEGER NOT NULL, UNIQUE(collection, key));
   CREATE INDEX store_idempotency_order ON store_idempotency(collection, seq);`,
];
export const STORE_SCHEMA_VERSION = MIGRATIONS.length;
/** How long one statement waits for a lock another process holds before failing (it blocks this process meanwhile). */
export const BUSY_TIMEOUT_MS = 2000;

/** SQLite releases carrying the fixes URLCode's SQLite stores require (the same floor as audit and abuse). */
export function patched(version: string): boolean { const [a = 0, b = 0, c = 0] = version.split('.').map(Number); return a > 3 || a === 3 && (b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6); }

/**
 * With `create`, creates the file 0600 (its directory 0700) when absent; without it, a missing file is an error. Then refuses anything that is not a private regular file
 * with one link. SQLite creates its `-wal` and `-shm` files with the database file's permissions.
 */
async function privateFile(path: string, create: boolean): Promise<string> {
  const requested = resolve(path);
  if (create) await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  let database: string;
  try { database = join(await realpath(dirname(requested)), basename(requested)); }
  catch { throw new Error('The store database does not exist'); }
  if (create) {
    try { await (await open(database, 'wx', 0o600)).close(); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
  const info = await lstat(database).catch(() => { throw new Error('The store database does not exist'); });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new Error('The store database must be a private regular file (mode 0600, one link)');
  return database;
}

/** One open store database: a single connection, a statement cache and the one transaction helper every write uses. */
export class StoreDatabase {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;
  private depth = 0;
  constructor(db: DatabaseSync) { this.db = db; }
  get open(): boolean { return !this.closed; }
  private statement(sql: string): StatementSync {
    if (this.closed) throw new Error('The store database is closed');
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  get<T>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.statement(sql).get(...values) as T | undefined; }
  all<T>(sql: string, ...values: SQLInputValue[]): T[] { return this.statement(sql).all(...values) as T[]; }
  run(sql: string, ...values: SQLInputValue[]): number { return Number(this.statement(sql).run(...values).changes); }
  /**
   * Runs `work` inside BEGIN IMMEDIATE ... COMMIT: the write lock is taken before the first read, so everything
   * `work` reads is still true when it commits. `DEFERRED` is for reads: one consistent snapshot, no write lock. Any throw rolls the whole transaction back and is rethrown unchanged.
   * `work` is synchronous, so no other request of this process can run between its statements. Not reentrant.
   */
  transaction<T>(work: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
    if (this.closed) throw new Error('The store database is closed');
    if (this.depth) throw new Error('Store transactions do not nest');
    this.db.exec(`BEGIN ${mode}`);
    this.depth++;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* The original error wins. */ } throw error; }
    finally { this.depth--; }
  }
  close(): void { if (!this.closed) { this.closed = true; this.statements.clear(); this.db.close(); } }
}

/** Reads the identity pragmas and refuses a file that is neither empty nor a store database this release understands. */
function versionOf(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version), application = Number(db.prepare('PRAGMA application_id').get()?.application_id);
  if (version === 0 && application === 0 && Number(db.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.n) === 0) return 0;
  if (application !== STORE_APPLICATION_ID || version < 1) throw new Error('Not a store database');
  if (version > STORE_SCHEMA_VERSION) throw new Error(`The store database has schema version ${version}; this release supports up to ${STORE_SCHEMA_VERSION}`);
  return version;
}

/**
 * Opens (creating when absent, unless `create` is false) the store database and brings its schema forward. Each missing step runs in its own
 * BEGIN IMMEDIATE transaction together with the new `user_version`, so a crash mid-upgrade leaves the previous version.
 * Opening an up-to-date database changes nothing.
 */
export async function openStoreDatabase(path: string, options: { create?: boolean } = {}): Promise<StoreDatabase> {
  if (!patched(process.versions.sqlite || '')) throw new Error(`The store requires a patched SQLite (3.44.6, 3.50.7, 3.51.3 or newer); this Node has ${process.versions.sqlite || 'none'}`);
  const db = new DatabaseSync(await privateFile(path, options.create !== false), { allowExtension: false });
  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema=OFF;`);
    let version = versionOf(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    while (version < STORE_SCHEMA_VERSION) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Re-read under the write lock: another opener may have upgraded it meanwhile.
        const current = versionOf(db);
        if (current === version) {
          db.exec(MIGRATIONS[version]!);
          db.exec(`PRAGMA application_id=${STORE_APPLICATION_ID}; PRAGMA user_version=${version + 1};`);
        }
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* No open transaction. */ } throw error; }
      version = versionOf(db);
    }
  } catch (error) { db.close(); throw error; }
  return new StoreDatabase(db);
}
