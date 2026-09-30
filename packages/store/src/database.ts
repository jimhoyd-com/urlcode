// The store's one SQLite database per site (#835): every collection's records, retained Idempotency-Key claims
// (of HTTP writes and of host transactions) and undelivered audit events are rows in shared tables, so a record
// write, its claim and its audit event commit in one transaction. Direct parameterized SQL through node:sqlite; no query builder. The schema only ever moves
// forward: an empty file is initialized to the newest version, an older store schema is upgraded step by step in
// one transaction each, and a newer or foreign one is refused before anything is served.
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { refuseNetworkFilesystem } from './topology.ts';
import type { HostProbe } from './topology.ts';

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
  // 2 -> 3. When the serving process's audit drain last kept up with the outbox (#875): one row, the epoch
  // milliseconds of its last ack or empty peek. An operator command reads it to warn that the events it just wrote
  // wait for a drain that is not running. A database no drain has touched has no row.
  `CREATE TABLE store_audit_drain(id INTEGER PRIMARY KEY CHECK (id = 1), drained_at INTEGER NOT NULL);`,
  // 3 -> 4. Retries for host transactions (#902): one row per retained `StoreExports.transaction` idempotency key, the
  // SHA-256 of the key and of the caller's fingerprint, and the transaction's JSON result (NULL for `undefined`),
  // written in the transaction it records. Keys are store-wide, not per collection: a transaction spans collections.
  `CREATE TABLE store_transaction_results(seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
     fingerprint TEXT NOT NULL, result TEXT CHECK (result IS NULL OR json_valid(result)), claimed_at INTEGER NOT NULL);`,
  // 4 -> 5. Several serving processes on one host (#927). `store_declarations`: per collection, the fingerprint of the
  // declaration the newest activation serves and the schema version it was built for; every serving write checks its
  // own against it under the write lock (the declaration fence). `store_servers`: one lease row per serving process,
  // renewed by its heartbeat, so an activation can see a live peer on another host. The drain marker gains the audit
  // drain's lease (`holder`, `lease_until`), so one process drains the outbox; `drained_at` is NULL until a drain kept up.
  `CREATE TABLE store_declarations(collection TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, schema_version INTEGER NOT NULL,
     activated_at INTEGER NOT NULL) WITHOUT ROWID;
   CREATE TABLE store_servers(instance TEXT PRIMARY KEY, host TEXT NOT NULL, boot TEXT, pid INTEGER NOT NULL,
     heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID;
   CREATE TABLE store_audit_drain_next(id INTEGER PRIMARY KEY CHECK (id = 1), drained_at INTEGER, holder TEXT,
     lease_until INTEGER NOT NULL DEFAULT 0);
   INSERT INTO store_audit_drain_next(id, drained_at) SELECT id, drained_at FROM store_audit_drain;
   DROP TABLE store_audit_drain;
   ALTER TABLE store_audit_drain_next RENAME TO store_audit_drain;`,
];
export const STORE_SCHEMA_VERSION = MIGRATIONS.length;
/**
 * How much a commit waits for the disk (#859), an operator choice per site and never project YAML. `full` (the default,
 * SQLite `synchronous=FULL`) fsyncs the write-ahead log on every commit, so a committed write survives power loss.
 * `normal` (`synchronous=NORMAL`) fsyncs only at checkpoints: a commit still survives a process crash and the database
 * never corrupts, but the last commits before a power loss or OS crash can be lost. OFF and EXTRA are refused.
 */
export type StoreDurability = 'full' | 'normal';
export const STORE_DURABILITIES: readonly StoreDurability[] = ['full', 'normal'];
/** The durability named by `value`, or a thrown error naming the accepted values. `undefined` is the default, `full`. */
export function storeDurability(value: unknown): StoreDurability {
  if (value === undefined) return 'full';
  if (typeof value === 'string' && (STORE_DURABILITIES as readonly string[]).includes(value)) return value as StoreDurability;
  throw new Error(`Store durability must be one of ${STORE_DURABILITIES.join(', ')}; got ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`);
}
/** How long one statement waits for a lock another process holds before failing (it blocks this process meanwhile). */
export const BUSY_TIMEOUT_MS = 2000;

/** SQLite releases carrying the fixes URLCode's SQLite stores require (the same floor as audit). */
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
  /**
   * Run first inside every write transaction (after `BEGIN IMMEDIATE`, under the write lock) when set: a serving process
   * sets it to its host lease's `verify` (#978), so a process that lost the lease writes nothing. Its throw rolls back.
   */
  writeGuard: (() => void) | undefined;
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
   * `guarded: false` skips `writeGuard` (the host lease's own heartbeat).
   */
  transaction<T>(work: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE', guarded = true): T {
    if (this.closed) throw new Error('The store database is closed');
    if (this.depth) throw new Error('Store transactions do not nest');
    this.db.exec(`BEGIN ${mode}`);
    this.depth++;
    try {
      if (mode === 'IMMEDIATE' && guarded) this.writeGuard?.();
      const result = work(); this.db.exec('COMMIT'); return result;
    }
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
 * Opens (creating when absent, unless `create` is false) the store database and brings its schema forward. A database
 * directory on a network filesystem is refused first (`refuseNetworkFilesystem`; `probe` is a test seam). `durability`
 * sets the connection's `synchronous` level (default `full`); the operator commands never pass it, so they always commit
 * with FULL whatever the serving process uses. Each missing step runs in its own
 * BEGIN IMMEDIATE transaction together with the new `user_version`, so a crash mid-upgrade leaves the previous version.
 * Opening an up-to-date database changes nothing.
 */
export async function openStoreDatabase(path: string, options: { create?: boolean; durability?: StoreDurability; probe?: Partial<HostProbe> } = {}): Promise<StoreDatabase> {
  const synchronous = storeDurability(options.durability).toUpperCase();
  if (!patched(process.versions.sqlite || '')) throw new Error(`The store requires a patched SQLite (3.44.6, 3.50.7, 3.51.3 or newer); this Node has ${process.versions.sqlite || 'none'}`);
  const file = await privateFile(path, options.create !== false);
  await refuseNetworkFilesystem(dirname(file), 'store', options.probe);
  const db = new DatabaseSync(file, { allowExtension: false });
  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA trusted_schema=OFF;`);
    let version = versionOf(db);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${synchronous};`);
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

/** Records that the audit drain kept up with the outbox at `now` (epoch ms): after an ack, or a peek that found it empty. */
export function markAuditDrained(db: StoreDatabase, now: number): void {
  db.run('INSERT INTO store_audit_drain(id, drained_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET drained_at = max(coalesce(drained_at, 0), excluded.drained_at)', now);
}
/**
 * How long the audit drain's lease lasts (#927). Its holder renews it once less than half is left, which its 1 second
 * poll does long before expiry; a peer takes the drain over only after the lease expired (or was released on close).
 */
export const AUDIT_DRAIN_LEASE_MS = 10_000;
/**
 * Whether `holder` (a serving process's lease instance) may drain the outbox now: it holds an unexpired lease, or it
 * takes one because nobody else holds an unexpired one. A renewal or take-over is one write transaction; a holder with
 * more than half its lease left and a process that sees another's unexpired lease only read.
 */
export function holdsAuditDrain(db: StoreDatabase, holder: string, now: number): boolean {
  type Lease = { holder: string | null; lease_until: number };
  const other = (lease: Lease | undefined): boolean => lease !== undefined && lease.holder !== null && lease.holder !== holder && lease.lease_until > now;
  const seen = db.get<Lease>('SELECT holder, lease_until FROM store_audit_drain WHERE id = 1');
  if (seen?.holder === holder && seen.lease_until - now > AUDIT_DRAIN_LEASE_MS / 2) return true;
  if (other(seen)) return false;
  return db.transaction(() => {
    // Re-read under the write lock: of two processes whose leases both look expired, one takes it.
    if (other(db.get<Lease>('SELECT holder, lease_until FROM store_audit_drain WHERE id = 1'))) return false;
    db.run('INSERT INTO store_audit_drain(id, holder, lease_until) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until', holder, now + AUDIT_DRAIN_LEASE_MS);
    return true;
  });
}
/** Whether `holder` still holds the drain lease, read inside the caller's transaction (an ack deletes only then). */
export function auditDrainHolder(db: StoreDatabase, holder: string): boolean {
  return db.get<{ holder: string | null }>('SELECT holder FROM store_audit_drain WHERE id = 1')?.holder === holder;
}
/** Gives the drain lease up (a closing process), so a peer takes over at its next poll instead of after expiry. */
export function releaseAuditDrain(db: StoreDatabase, holder: string): void {
  db.run('UPDATE store_audit_drain SET lease_until = 0 WHERE id = 1 AND holder = ?', holder);
}

/**
 * The declaration fence (#927). An activation records, per collection, the fingerprint of the declaration it serves
 * and the schema version it was built for, replacing whatever an earlier activation (in this process or another)
 * recorded: the newest activation wins. `declarationOf` is the one indexed read a write makes under its write lock to
 * compare its own with them and with the file's `user_version`. `check` runs first, under the same write lock: what it
 * reads cannot change before the declarations it guards are recorded, since every later write through another
 * declaration is refused by the fence. A throw from it records nothing.
 */
export function recordDeclarations(db: StoreDatabase, fingerprints: ReadonlyMap<string, string>, now: number, check?: () => void): void {
  db.transaction(() => {
    check?.();
    db.run('DELETE FROM store_declarations');
    for (const [collection, fingerprint] of fingerprints) db.run('INSERT INTO store_declarations(collection, fingerprint, schema_version, activated_at) VALUES (?, ?, ?, ?)', collection, fingerprint, STORE_SCHEMA_VERSION, now);
  });
}
/** The recorded declaration of `collection` and the file's schema version, or `undefined` when none is recorded. */
export function declarationOf(db: StoreDatabase, collection: string): { fingerprint: string; schema_version: number; version: number } | undefined {
  return db.get('SELECT fingerprint, schema_version, (SELECT user_version FROM pragma_user_version) AS version FROM store_declarations WHERE collection = ?', collection);
}
/** Whether any serving process holds an unexpired lease on the database (`store_servers`). */
export function liveServer(db: StoreDatabase, now: number): boolean {
  return db.get('SELECT 1 AS found FROM store_servers WHERE expires_at > ? LIMIT 1', now) !== undefined;
}
/** How old the last drain may be before an operator command warns that its events are not being delivered. */
export const AUDIT_DRAIN_STALE_MS = 60_000;
/**
 * What an operator command reports after writing audit events (#875): the events still undelivered in each collection
 * it touched, when the drain last kept up (`null`: never), and a `warning` when some wait and no drain has kept up
 * within `AUDIT_DRAIN_STALE_MS`, so they are delivered only once a server with the audit extension serves again.
 */
export interface AuditDelivery { undeliveredEvents: Record<string, number>; lastAuditDrain: string | null; warning?: string }
export function auditDelivery(db: StoreDatabase, collections: readonly string[], now: number): AuditDelivery {
  const undeliveredEvents: Record<string, number> = {};
  for (const collection of [...new Set(collections)].sort())
    undeliveredEvents[collection] = db.get<{ n: number }>('SELECT count(*) AS n FROM store_audit_outbox WHERE collection = ?', collection)!.n;
  const drainedAt = db.get<{ drained_at: number | null }>('SELECT drained_at FROM store_audit_drain WHERE id = 1')?.drained_at ?? undefined;
  const report: AuditDelivery = { undeliveredEvents, lastAuditDrain: drainedAt === undefined ? null : new Date(drainedAt).toISOString() };
  const waiting = Object.values(undeliveredEvents).reduce((sum, n) => sum + n, 0);
  if (waiting && (drainedAt === undefined || now - drainedAt > AUDIT_DRAIN_STALE_MS)) {
    const since = drainedAt === undefined ? 'No audit drain has run against this database' : `The audit drain last kept up ${Math.round((now - drainedAt) / 1000)} s ago`;
    report.warning = `${since}: ${waiting} audit event${waiting === 1 ? '' : 's'} wait in the outbox and are delivered only while a server with the audit extension serves this project. Start it, or check that it is running.`;
  }
  return report;
}
