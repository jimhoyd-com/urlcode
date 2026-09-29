// The setups the store refuses at activation (#927). The supported topology is N serving processes (or containers)
// on one host, on one release, with the database on local disk. SQLite's write-ahead log needs its `-shm` file on one
// kernel and its locks are unreliable over network filesystems, so two things are checked before anything is served:
// the database directory's filesystem (Linux only), and, through a lease table in the database, that no live peer
// serves it from another host.
import { randomUUID } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { StoreDatabase } from './database.ts';

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
 * Refuses a database directory on a network filesystem (`NETWORK_FILESYSTEMS`). Linux only: macOS and Windows expose no
 * filesystem type a check can trust through Node, so there it is skipped, and the lease below is what notices a peer on
 * another host.
 */
export async function refuseNetworkFilesystem(directory: string, what: string, probe: HostProbe = hostProbe): Promise<void> {
  if (probe.platform !== 'linux') return;
  // `f_type` is a signed long in the kernel's ABI; the magic numbers are unsigned 32-bit values.
  const type = Number((await probe.statfs(directory)).type) >>> 0, name = NETWORK_FILESYSTEMS.get(type);
  if (name) throw new Error(`The ${what} database is on a ${name} filesystem (statfs type 0x${type.toString(16)}); SQLite needs it on local disk. Move it to a local filesystem.`);
}

/** How often a serving process renews its lease, and how long an unrenewed lease counts as live. */
export const SERVER_LEASE = { heartbeatMs: 5_000, ttlMs: 20_000 } as const;
/** A serving process's row in `store_servers`: its instance id (also the audit drain lease holder) and how many live peers it saw on joining. */
export interface ServerLease { readonly instance: string; readonly peers: number; close(): void }
interface Peer { instance: string; host: string; boot: string | null; expires_at: number }

/**
 * Joins the database's server leases: in one write transaction, drops expired leases, refuses when a live peer is on
 * another host (another kernel boot id; the hostname only when either side has none, since containers on one host
 * have their own hostnames but share the boot id), and inserts this process's lease. A heartbeat renews it every
 * `SERVER_LEASE.heartbeatMs` (a busy lock is retried at the next beat); `close` stops it and deletes the row.
 */
export async function joinServers(db: StoreDatabase, probe: HostProbe = hostProbe, now: () => number = Date.now): Promise<ServerLease> {
  const instance = randomUUID(), host = probe.hostname().slice(0, 255), boot = (await probe.bootId())?.slice(0, 64) ?? null;
  const foreign = (peer: Peer): boolean => boot !== null && peer.boot !== null ? peer.boot !== boot : peer.host !== host;
  // One write transaction: a refusal on joining throws inside it, so this process's lease row rolls back with it.
  const beat = (joining: boolean): number => db.transaction(() => {
    const at = now();
    db.run('DELETE FROM store_servers WHERE expires_at <= ?', at);
    const peers = db.all<Peer>('SELECT instance, host, boot, expires_at FROM store_servers WHERE instance <> ?', instance);
    const other = joining ? peers.find(foreign) : undefined;
    if (other) throw new Error(`Another server on host ${JSON.stringify(other.host.slice(0, 64))} holds a live lease on this store database: a store database is served from one host only (several processes on one host are supported). If that host is gone, its lease expires within ${Math.ceil(SERVER_LEASE.ttlMs / 1000)} s of its last heartbeat.`);
    db.run('INSERT INTO store_servers(instance, host, boot, pid, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(instance) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at', instance, host, boot, process.pid, at, at + SERVER_LEASE.ttlMs);
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
      try { db.run('DELETE FROM store_servers WHERE instance = ?', instance); } catch { /* It expires on its own. */ }
    },
  };
}
