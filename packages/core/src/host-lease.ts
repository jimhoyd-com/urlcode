// The setups a SQLite-backed extension refuses before it serves (#927, #941). The supported topology is N serving
// processes (or containers) on one host with the database on local disk: SQLite's write-ahead log needs its `-shm` file
// on one kernel, and its locks are unreliable over network filesystems. Two checks, shared by every extension that keeps
// a SQLite database (store, auth, audit) so their lists and rules cannot drift: the database directory's filesystem type
// (Linux only), and a lease table in the database itself that refuses activation while a live peer serves it from
// another host, and makes a serving process stop writing once another host holds it (#978). Core owns no table: each
// extension names its own, in its own database.
import { randomUUID } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';

/**
 * What the setup checks read from the machine. `hostProbe` is the real one; tests pass a fake (a network filesystem
 * type, another boot id, a clock they move). An operator never sets it.
 */
export interface HostProbe {
  platform: NodeJS.Platform;
  statfs(path: string): Promise<{ type: number | bigint }>;
  hostname(): string;
  /** The kernel's boot id (`/proc/sys/kernel/random/boot_id`, Linux), which containers on one host share; `undefined` elsewhere. */
  bootId(): Promise<string | undefined>;
  /** This process's monotonic clock in milliseconds: the host lease times another row's silence on it. */
  monotonic(): number;
  /** Waits `ms` milliseconds (a joining lease watching another host's row). */
  sleep(ms: number): Promise<void>;
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
  monotonic: () => performance.now(),
  sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
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

/**
 * The lease's timing. A serving process renews its row every `heartbeatMs`. A row an observer watched stay unchanged for
 * `ttlMs` on the observer's own monotonic clock is dead, and the observer deletes it. A joiner watches another host's row
 * every `pollMs`. A holder writes only while its last committed heartbeat began less than `writeMs` ago, or after
 * reading its row under the write's own lock: a peer needs `ttlMs` of silence to take over, so no write of the old
 * holder can follow the take-over.
 */
export const SERVER_LEASE = { heartbeatMs: 5_000, ttlMs: 20_000, pollMs: 1_000, writeMs: 10_000 } as const;
/**
 * A serving process's lease: its row's instance id, how many live peers (on this host) it saw on joining, and whether
 * it still holds the lease. It is lost when a heartbeat finds another host's row (its own gone or not): the process
 * deletes its row, logs, refuses writes, and rejoins by itself once no other host holds a row.
 */
export interface HostLease {
  readonly instance: string;
  readonly peers: number;
  /** Whether this process held the lease at its last heartbeat. */
  readonly held: boolean;
  /**
   * Throws unless this process may write now. Call it inside the write's own transaction, after `BEGIN IMMEDIATE`: when
   * the last heartbeat is older than `SERVER_LEASE.writeMs`, it reads the lease table under that write lock instead.
   */
  verify(): void;
  /**
   * For writes the extension cannot wrap in a transaction of its own (Better Auth's): whether this process may serve
   * now, running a heartbeat first (at most once a second) when the lease is lost or its last renewal is older than
   * `SERVER_LEASE.writeMs`.
   */
  renew(): boolean;
  close(): void;
}

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
  /** This host's wall clock. Only this host's peers compare it (a row's expiry); another host's rows are timed on `monotonic`. */
  now?: (() => number) | undefined;
  /** Where a lost, regained or failing lease is reported: the process's stderr by default. */
  log?: ((message: string) => void) | undefined;
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

interface Peer { instance: string; host: string; boot: string | null; heartbeat_at: number; expires_at: number }
/** Another row as this process saw it: its heartbeat value, when (monotonic) that value was first seen, whether it ever changed. */
interface Watched { value: number; since: number; advanced: boolean }

/**
 * Joins the database's server leases in `options.table` (created when absent) and renews this process's row. A peer is
 * on another host when its kernel boot id differs (the hostname only when either side has none, since containers on one
 * host have their own hostnames but share the boot id). Processes on one host each hold a row and never refuse each other.
 *
 * Liveness never compares two hosts' wall clocks. A row's `heartbeat_at` grows with every renewal, and an observer
 * judges another row by whether that value changes, timed on its own monotonic clock. A row of this host (one kernel,
 * one clock) is also dead once its `expires_at` passed. So joining waits while another host's row is present: it
 * refuses once that row advances, and deletes it and joins once it stayed unchanged for `SERVER_LEASE.ttlMs`.
 */
export async function joinHostLease(db: HostLeaseStatements | HostLeaseConnection, options: HostLeaseOptions): Promise<HostLease> {
  const { table, what } = options, now = options.now ?? Date.now, machine = { ...hostProbe, ...options.probe };
  const log = options.log ?? ((message: string) => { process.stderr.write(`${what}: ${message}\n`); });
  if (!/^[a-z_]{1,64}$/.test(table)) throw new Error(`Invalid host lease table name ${JSON.stringify(table)}`);
  const sql = statements(db), instance = randomUUID(), host = machine.hostname().slice(0, 255), boot = (await machine.bootId())?.slice(0, 64) ?? null;
  const foreign = (peer: Pick<Peer, 'host' | 'boot'>): boolean => boot !== null && peer.boot !== null ? peer.boot !== boot : peer.host !== host;
  const named = (peer: Peer): string => JSON.stringify(peer.host.slice(0, 64));
  const seconds = (ms: number): number => Math.ceil(ms / 1000), article = /^[aeiou]/.test(what) ? 'an' : 'a';
  const watched = new Map<string, Watched>();
  let written = 0;
  // Every row under the caller's write lock, the dead ones deleted: this process's own, the others, and those of other hosts.
  const survey = (): { own: boolean; others: Peer[]; hosts: Peer[] } => {
    const at = now(), tick = machine.monotonic();
    const rows = sql.all<Peer>(`SELECT instance, host, boot, heartbeat_at, expires_at FROM ${table}`);
    const others: Peer[] = [];
    let own = false;
    for (const row of rows) {
      if (row.instance === instance) { own = true; continue; }
      const last = watched.get(row.instance);
      const seen = last?.value === row.heartbeat_at ? last : { value: row.heartbeat_at, since: tick, advanced: last !== undefined };
      watched.set(row.instance, seen);
      if ((!foreign(row) && row.expires_at <= at) || tick - seen.since >= SERVER_LEASE.ttlMs) {
        sql.run(`DELETE FROM ${table} WHERE instance = ? AND heartbeat_at = ?`, row.instance, row.heartbeat_at);
        watched.delete(row.instance);
      } else others.push(row);
    }
    for (const key of watched.keys()) if (!rows.some(row => row.instance === key)) watched.delete(key);
    return { own, others, hosts: others.filter(foreign) };
  };
  // Every renewal writes a larger heartbeat value than the last, whatever this host's wall clock does.
  const stamp = (): void => {
    const at = now();
    written = Math.max(at, written + 1);
    sql.run(`INSERT INTO ${table}(instance, host, boot, pid, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(instance) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`, instance, host, boot, process.pid, written, at + SERVER_LEASE.ttlMs);
  };

  // Joining: one write transaction per look, so a refusal leaves no row of this process behind.
  let peers: number, confirmed: number, announced = false;
  for (let first = true; ; first = false) {
    const started = machine.monotonic();
    const outcome = sql.transaction((): { peers: number } | { waiting: Peer } => {
      if (first) sql.run(`CREATE TABLE IF NOT EXISTS ${table}(instance TEXT PRIMARY KEY, host TEXT NOT NULL, boot TEXT, pid INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID`);
      const { others, hosts } = survey();
      const live = hosts.find(peer => watched.get(peer.instance)?.advanced);
      if (live) throw new Error(`Another server on host ${named(live)} holds a live lease on this ${what} database: ${article} ${what} database is served from one host only (several processes on one host are supported). Its heartbeat advanced while this process watched it: stop that server, or serve from its host.`);
      if (hosts.length) return { waiting: hosts[0]! };
      stamp();
      return { peers: others.length };
    });
    if ('peers' in outcome) { peers = outcome.peers; confirmed = started; break; }
    if (!announced) {
      announced = true;
      log(`host ${named(outcome.waiting)} has a lease row on this ${what} database; watching its heartbeat for up to ${seconds(SERVER_LEASE.ttlMs)} s: activation is refused if it advances, and the row is deleted if it does not`);
    }
    await machine.sleep(SERVER_LEASE.pollMs);
  }

  let held = true, closed = false, failing = false, attempted = -Infinity;
  // A heartbeat in its own write transaction. Holding: renew the row, or lose the lease to another host's row. Lost:
  // keep watching the other rows, and rejoin once none of another host is left.
  const beat = (): void => {
    const started = machine.monotonic();
    const outcome = sql.transaction((): { peer?: Peer; rejoined?: boolean } => {
      const { own, hosts } = survey();
      if (hosts.length) {
        if (own) sql.run(`DELETE FROM ${table} WHERE instance = ?`, instance);
        return { peer: hosts[0]! };
      }
      stamp();
      return { rejoined: !own };
    });
    if (outcome.peer) {
      if (held) log(`the ${what} database's host lease is lost: host ${named(outcome.peer)} holds a lease on it. This process refuses ${what} writes (503) until no other host holds one: ${article} ${what} database is served from one host only, so stop one of the two`);
      held = false;
      return;
    }
    confirmed = started;
    if (!held) log(`this process holds the ${what} database's host lease again and accepts writes`);
    else if (outcome.rejoined) log(`this process's ${what} lease row had been deleted (it was not renewed for ${seconds(SERVER_LEASE.ttlMs)} s); no other host holds one, so it rejoined`);
    held = true;
  };
  const timer = setInterval(() => {
    try {
      beat();
      if (failing) { failing = false; log(`the ${what} host lease heartbeat succeeds again`); }
    } catch (error) {
      if (!failing) { failing = true; log(`the ${what} host lease heartbeat failed (${error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : 'unknown error'}); it retries every ${seconds(SERVER_LEASE.heartbeatMs)} s`); }
    }
  }, SERVER_LEASE.heartbeatMs);
  timer.unref();
  const fresh = (): boolean => held && machine.monotonic() - confirmed < SERVER_LEASE.writeMs;
  const refusal = (): Error => new Error(`This process does not hold the ${what} database's host lease`);
  return {
    instance, peers,
    get held() { return held && !closed; },
    verify() {
      if (closed || !held) throw refusal();
      if (fresh()) return;
      // Under the caller's write lock: no peer can delete this row before that transaction ends.
      const rows = sql.all<Pick<Peer, 'instance' | 'host' | 'boot'>>(`SELECT instance, host, boot FROM ${table}`);
      if (!rows.some(row => row.instance === instance) || rows.some(row => row.instance !== instance && foreign(row))) throw refusal();
    },
    renew() {
      if (closed) return false;
      if (fresh()) return true;
      const tick = machine.monotonic();
      if (tick - attempted >= 1000) { attempted = tick; try { beat(); } catch { /* A busy lock or an open transaction: the timer retries. */ } }
      return fresh();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { sql.run(`DELETE FROM ${table} WHERE instance = ?`, instance); } catch { /* Observers delete it once it stops changing. */ }
    },
  };
}
