// The setups a SQLite-backed extension refuses before it serves (#927, #941). The supported topology is N serving
// processes (or containers) on one host with the database on local disk: SQLite's write-ahead log needs its `-shm` file
// on one kernel, and its locks are unreliable over network filesystems. Two checks, shared by every extension that keeps
// a SQLite database (store, auth, audit) so their lists and rules cannot drift: the database directory's filesystem type
// (Linux only), and a lease table in the database itself that refuses activation while a live peer serves it from
// another host. Core owns no table: each extension names its own, in its own database.
import { randomUUID } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * What the setup checks read from the machine. `hostProbe` is the real one; tests pass a fake (a network filesystem
 * type, another boot id). An operator never sets it.
 */
export interface HostProbe {
  platform: NodeJS.Platform;
  statfs(path: string): Promise<{ type: number | bigint }>;
  hostname(): string;
  /** The kernel's boot id (`/proc/sys/kernel/random/boot_id`, Linux), which containers on one host share; `undefined` elsewhere. */
  bootId(): Promise<string | undefined>;
}
export const hostProbe: HostProbe = {
  platform: process.platform,
  statfs: path => statfs(path),
  hostname,
  async bootId() {
    if (process.platform !== 'linux') return undefined;
    try { const id = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); return /^[0-9a-f-]{36}$/.test(id) ? id : undefined; }
    catch { return undefined; }
  },
};

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
 * trust through Node, so there it is skipped, and the host lease is what notices a peer on another host. Fields the
 * probe leaves out are the real machine's.
 */
export async function refuseNetworkFilesystem(directory: string, what: string, probe: Partial<HostProbe> = hostProbe): Promise<void> {
  const machine = { ...hostProbe, ...probe };
  if (machine.platform !== 'linux') return;
  // `f_type` is a signed long in the kernel's ABI; the magic numbers are unsigned 32-bit values.
  const type = Number((await machine.statfs(directory)).type) >>> 0, name = NETWORK_FILESYSTEMS.get(type);
  if (name) throw new Error(`The ${what} database is on a ${name} filesystem (statfs type 0x${type.toString(16)}); SQLite needs it on local disk. Move it to a local filesystem.`);
}

/** How often a serving process renews its lease, and how long an unrenewed lease counts as live. */
export const SERVER_LEASE = { heartbeatMs: 5_000, ttlMs: 20_000 } as const;
/** A serving process's lease row: its instance id and how many live peers (on this host) it saw on joining. */
export interface HostLease { readonly instance: string; readonly peers: number; close(): void }

type LeaseValue = string | number | null;
/** A connection with its own write transaction helper (the store's `StoreDatabase`). */
export interface HostLeaseStatements {
  transaction<T>(work: () => T): T;
  run(sql: string, ...values: LeaseValue[]): unknown;
  all<T>(sql: string, ...values: LeaseValue[]): T[];
}
/** A plain `node:sqlite` `DatabaseSync` (auth, audit): the lease runs its own `BEGIN IMMEDIATE` on it. */
export interface HostLeaseConnection {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: LeaseValue[]): unknown; all(...values: LeaseValue[]): unknown[] };
}
export interface HostLeaseOptions {
  /** The extension's lease table in its own database, created when absent. Lower-case letters and `_` only. */
  table: string;
  /** The database's name in the refusal ("store", "auth", "audit"). */
  what: string;
  probe?: Partial<HostProbe> | undefined;
  now?: (() => number) | undefined;
}

function statements(db: HostLeaseStatements | HostLeaseConnection): HostLeaseStatements {
  if ('transaction' in db) return db;
  return {
    transaction(work) {
      // BEGIN outside the try: when it fails (the connection already has a transaction open, or the lock stayed busy)
      // there is nothing of ours to roll back, and rolling back would end the other transaction.
      db.exec('BEGIN IMMEDIATE');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { try { db.exec('ROLLBACK'); } catch { /* The original error wins. */ } throw error; }
    },
    run: (sql, ...values) => db.prepare(sql).run(...values),
    all: <T>(sql: string, ...values: LeaseValue[]) => db.prepare(sql).all(...values) as T[],
  };
}

interface Peer { instance: string; host: string; boot: string | null }

/**
 * Joins the database's server leases in `options.table`: in one write transaction, creates the table when absent, drops
 * expired leases, refuses when a live peer is on another host (another kernel boot id; the hostname only when either
 * side has none, since containers on one host have their own hostnames but share the boot id), and inserts this
 * process's lease. A heartbeat renews it every `SERVER_LEASE.heartbeatMs` (a busy lock is retried at the next beat);
 * `close` stops it and deletes the row. Several processes on one host each hold a row and never refuse each other.
 */
export async function joinHostLease(db: HostLeaseStatements | HostLeaseConnection, options: HostLeaseOptions): Promise<HostLease> {
  const { table, what } = options, now = options.now ?? Date.now, machine = { ...hostProbe, ...options.probe };
  if (!/^[a-z_]{1,64}$/.test(table)) throw new Error(`Invalid host lease table name ${JSON.stringify(table)}`);
  const sql = statements(db), instance = randomUUID(), host = machine.hostname().slice(0, 255), boot = (await machine.bootId())?.slice(0, 64) ?? null;
  const foreign = (peer: Peer): boolean => boot !== null && peer.boot !== null ? peer.boot !== boot : peer.host !== host;
  // One write transaction: a refusal on joining throws inside it, so this process's lease row rolls back with it.
  const beat = (joining: boolean): number => sql.transaction(() => {
    const at = now();
    if (joining) sql.run(`CREATE TABLE IF NOT EXISTS ${table}(instance TEXT PRIMARY KEY, host TEXT NOT NULL, boot TEXT, pid INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID`);
    sql.run(`DELETE FROM ${table} WHERE expires_at <= ?`, at);
    const peers = sql.all<Peer>(`SELECT instance, host, boot FROM ${table} WHERE instance <> ?`, instance);
    const other = joining ? peers.find(foreign) : undefined;
    if (other) throw new Error(`Another server on host ${JSON.stringify(other.host.slice(0, 64))} holds a live lease on this ${what} database: ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} database is served from one host only (several processes on one host are supported). If that host is gone, its lease expires within ${Math.ceil(SERVER_LEASE.ttlMs / 1000)} s of its last heartbeat.`);
    sql.run(`INSERT INTO ${table}(instance, host, boot, pid, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(instance) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`, instance, host, boot, process.pid, at, at + SERVER_LEASE.ttlMs);
    return peers.length;
  });
  const peers = beat(true);
  const timer = setInterval(() => { try { beat(false); } catch { /* A busy lock: the next beat renews it well before expiry. */ } }, SERVER_LEASE.heartbeatMs);
  timer.unref();
  let closed = false;
  return {
    instance, peers,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { sql.run(`DELETE FROM ${table} WHERE instance = ?`, instance); } catch { /* It expires on its own. */ }
    },
  };
}
