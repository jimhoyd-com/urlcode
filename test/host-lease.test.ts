import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { joinHostLease, NETWORK_FILESYSTEMS, refuseNetworkFilesystem, SERVER_LEASE } from '../packages/core/src/host-lease.ts';
import type { HostLease, HostProbe } from '../packages/core/src/host-lease.ts';

// The shared setup checks of the SQLite-backed extensions (#927, #941, #978). The store, auth and audit tests exercise
// them through each extension's activation; these pin the rules themselves, with injected clocks: a wall clock per
// host and a monotonic clock that the joiner's `sleep` moves, so a 20 s TTL takes no real time.
// t.after hooks run in registration order, and Windows cannot delete a directory holding an open SQLite file (EBUSY):
// every connection is closed by the one hook that then removes the directory, so the order never depends on callers.
const opened = new Map<string, DatabaseSync[]>();
async function directory(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-lease-'));
  opened.set(dir, []);
  t.after(async () => {
    for (const db of opened.get(dir) ?? []) if (db.isOpen) db.close();
    opened.delete(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return dir;
}
/** One connection to the test database: a "host". Closed by its directory's cleanup, before the directory goes. */
function connect(_t: test.TestContext, dir: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, 'lease.sqlite'), { timeout: 2000 });
  db.exec('PRAGMA journal_mode=WAL');
  opened.get(dir)!.push(db);
  return db;
}
async function database(t: test.TestContext): Promise<DatabaseSync> { return connect(t, await directory(t)); }
const here = { hostname: () => 'web-1', bootId: async () => '11111111-1111-4111-8111-111111111111' };
const rows = (db: DatabaseSync) => db.prepare('SELECT host FROM t_servers ORDER BY host').all().map(row => row.host);
const peer = (db: DatabaseSync, host: string, boot: string | null, expires: number) =>
  db.prepare('INSERT INTO t_servers(instance, host, boot, pid, heartbeat_at, expires_at) VALUES (?, ?, ?, 1, ?, ?)').run(`peer-${host}-${String(boot)}`, host, boot, Date.now(), expires);
/** A monotonic clock the test owns. `sleep` advances it and then runs `during` (another host's heartbeat, say). */
function clock(during: () => void = () => {}): { now: number; probe: Pick<HostProbe, 'monotonic' | 'sleep'> } {
  const state = { now: 1_000_000, probe: { monotonic: () => state.now, sleep: async (ms: number) => { state.now += ms; during(); } } };
  return state;
}
const lease = (db: DatabaseSync, probe: Partial<HostProbe>, extra: { now?: () => number; log?: (message: string) => void } = {}) =>
  joinHostLease(db, { table: 't_servers', what: 'test', probe, log: () => {}, ...extra });

test('a host lease refuses a live peer on another host, never one on this host, and takes over a silent one', async t => {
  const db = await database(t);
  const first = await lease(db, here);
  assert.equal(first.peers, 0);
  // Another container on this kernel: its own hostname, the same boot id.
  const container = await lease(db, { hostname: () => 'web-2', bootId: here.bootId });
  assert.equal(container.peers, 1);
  container.close(); first.close();
  assert.deepEqual(rows(db), [], 'close deletes the row');

  // A row of this host (one kernel, one clock) is dead once its expiry passed.
  peer(db, 'web-1', '11111111-1111-4111-8111-111111111111', Date.now() - 1);
  const afterExpiry = await lease(db, here);
  assert.equal(afterExpiry.peers, 0, 'an expired lease of this host is no peer, and is dropped');
  afterExpiry.close();

  // Another host's row whose heartbeat advances while the joiner watches: refused, and the joiner leaves no row.
  peer(db, 'web-9', '22222222-2222-4222-8222-222222222222', Date.now() + SERVER_LEASE.ttlMs);
  const live = clock(() => { db.prepare("UPDATE t_servers SET heartbeat_at = heartbeat_at + 1 WHERE host = 'web-9'").run(); });
  await assert.rejects(lease(db, { ...here, ...live.probe }), /^Error: Another server on host "web-9" holds a live lease on this test database: a test database is served from one host only.*Its heartbeat advanced while this process watched it/);
  assert.ok(live.now - 1_000_000 <= SERVER_LEASE.pollMs, 'refused at the first heartbeat seen');
  assert.deepEqual(rows(db), ['web-9'], 'a refused join leaves no row');

  // The same row, silent: the joiner watches it for the TTL on its own monotonic clock, then deletes it and joins.
  const silent = clock(), said: string[] = [];
  const later = await lease(db, { ...here, ...silent.probe }, { log: message => said.push(message) });
  assert.ok(silent.now - 1_000_000 >= SERVER_LEASE.ttlMs && silent.now - 1_000_000 <= SERVER_LEASE.ttlMs + SERVER_LEASE.pollMs);
  assert.match(said.join('\n'), /host "web-9" has a lease row on this test database; watching its heartbeat for up to 20 s/);
  assert.deepEqual(rows(db), ['web-1']);
  later.close();
});

test('without a boot id on either side, a peer is compared by hostname', async t => {
  const db = await database(t);
  (await lease(db, here)).close();
  peer(db, 'mac', null, Date.now() + SERVER_LEASE.ttlMs);
  const beating = () => clock(() => { db.prepare("UPDATE t_servers SET heartbeat_at = heartbeat_at + 1 WHERE host = 'mac'").run(); }).probe;
  await assert.rejects(lease(db, { hostname: () => 'other-mac', bootId: async () => undefined, ...beating() }), /Another server on host "mac"/);
  // A Linux joiner with a boot id against a peer without one: still by hostname.
  await assert.rejects(lease(db, { ...here, ...beating() }), /Another server on host "mac"/);
  const same = await lease(db, { hostname: () => 'mac', bootId: async () => undefined });
  assert.equal(same.peers, 1);
  same.close();
});

test('a stalled holder whose row another host took over loses the lease and never re-inserts it (#978)', async t => {
  const dir = await directory(t), dbA = connect(t, dir), dbB = connect(t, dir);
  const shared = clock(), base = Date.now(), said: string[] = [];
  const A = await lease(dbA, { hostname: () => 'host-a', bootId: async () => 'boot-a', ...shared.probe }, { now: () => base, log: message => said.push(message) });
  t.after(() => A.close());
  // A stalls (no heartbeat); B watches A's row stay unchanged for the TTL, deletes it and joins.
  const B = await lease(dbB, { hostname: () => 'host-b', bootId: async () => 'boot-b', ...shared.probe }, { now: () => base + 25_000 });
  t.after(() => B.close());
  assert.deepEqual(rows(dbB), ['host-b']);
  // A resumes: a write checks the lease in its own transaction first, and its row is gone.
  dbA.exec('BEGIN IMMEDIATE');
  assert.throws(() => A.verify(), /This process does not hold the test database's host lease/);
  dbA.exec('ROLLBACK');
  // A's next heartbeat finds B: A loses the lease, logs it, and does not re-insert its row.
  shared.now += 1000;
  assert.equal(A.renew(), false);
  assert.equal(A.held, false);
  assert.deepEqual(rows(dbA), ['host-b'], 'one host serves');
  assert.match(said.join('\n'), /the test database's host lease is lost: host "host-b" holds a lease on it\. This process refuses test writes \(503\)/);
  dbA.exec('BEGIN IMMEDIATE');
  assert.throws(() => A.verify(), /does not hold/);
  dbA.exec('ROLLBACK');
  // B keeps its lease; once B closes, A rejoins at its next heartbeat and writes again.
  shared.now += SERVER_LEASE.writeMs;
  assert.equal(B.renew(), true);
  B.close();
  shared.now += 1000;
  assert.equal(A.renew(), true);
  assert.deepEqual(rows(dbA), ['host-a']);
  assert.match(said.at(-1)!, /holds the test database's host lease again and accepts writes/);
  dbA.exec('BEGIN IMMEDIATE');
  A.verify();
  dbA.exec('ROLLBACK');
});

test('a joiner whose wall clock is a day ahead does not evict a live holder (#978)', async t => {
  const dir = await directory(t), dbA = connect(t, dir), dbB = connect(t, dir);
  const base = Date.now();
  const holder: { A?: HostLease } = {};
  // One monotonic clock for both hosts (monotonic clocks only ever compare with themselves). A's heartbeat runs while B watches.
  const shared = clock(() => { holder.A?.renew(); });
  const A = holder.A = await lease(dbA, { hostname: () => 'host-a', bootId: async () => 'boot-a', ...shared.probe }, { now: () => base });
  t.after(() => A.close());
  await assert.rejects(lease(dbB, { hostname: () => 'host-b', bootId: async () => 'boot-b', ...shared.probe }, { now: () => base + 86_400_000 }), /Another server on host "host-a" holds a live lease/);
  assert.deepEqual(rows(dbA), ['host-a']);
  assert.equal(A.held, true);
});

test('a crashed host whose wall clock was a day ahead blocks a joiner for the TTL, not the skew (#978)', async t => {
  const dir = await directory(t), dbA = connect(t, dir), dbB = connect(t, dir);
  const base = Date.now();
  // A's row, written with a clock a day ahead; then its connection goes without close() (a crash).
  const A = await lease(dbA, { hostname: () => 'host-a', bootId: async () => 'boot-a' }, { now: () => base + 86_400_000 });
  dbA.close();
  t.after(() => A.close());
  const watching = clock(), said: string[] = [];
  const B = await lease(dbB, { hostname: () => 'host-b', bootId: async () => 'boot-b', ...watching.probe }, { now: () => base, log: message => said.push(message) });
  t.after(() => B.close());
  assert.ok(watching.now - 1_000_000 <= SERVER_LEASE.ttlMs + SERVER_LEASE.pollMs, `joined after ${watching.now - 1_000_000} ms of watching`);
  assert.deepEqual(rows(dbB), ['host-b']);
  assert.match(said[0]!, /watching its heartbeat for up to 20 s/);
});

test('a write checks the lease under its own lock once the heartbeat is stale, and a failed heartbeat keeps the lease', async t => {
  const dir = await directory(t), db = connect(t, dir), other = connect(t, dir);
  const shared = clock(), said: string[] = [];
  const held = await lease(db, { ...here, ...shared.probe }, { log: message => said.push(message) });
  t.after(() => held.close());
  // Stale, but the row is there and no other host has one: the write may proceed.
  shared.now += SERVER_LEASE.writeMs;
  db.exec('BEGIN IMMEDIATE'); held.verify(); db.exec('ROLLBACK');
  // Another host's row appears beside it (a protocol violation, or a joiner that deleted it): refused.
  peer(other, 'web-9', '22222222-2222-4222-8222-222222222222', Date.now() + SERVER_LEASE.ttlMs);
  db.exec('BEGIN IMMEDIATE'); assert.throws(() => held.verify(), /does not hold/); db.exec('ROLLBACK');
  other.exec("DELETE FROM t_servers WHERE host = 'web-9'");
  // A heartbeat that cannot take the lock (another connection holds a transaction open on this one) keeps the lease.
  db.exec('BEGIN');
  assert.equal(held.renew(), false, 'no fresh heartbeat while the lock cannot be taken');
  db.exec('ROLLBACK');
  assert.equal(held.held, true);
  shared.now += 1000;
  assert.equal(held.renew(), true);
});

test('a host lease on a plain connection never ends a transaction someone else opened', async t => {
  const db = await database(t);
  db.exec('BEGIN; CREATE TABLE kept(x); INSERT INTO kept VALUES (1);');
  await assert.rejects(lease(db, here), /within a transaction/);
  db.exec('COMMIT');
  assert.equal((db.prepare('SELECT count(*) AS n FROM kept').get() as { n: number }).n, 1);
  await assert.rejects(joinHostLease(db, { table: 'bad-name', what: 'test', probe: here }), /Invalid host lease table name/);
});

test('a database directory on a network filesystem is refused on Linux and not checked elsewhere', async () => {
  for (const [type, name] of [[0x6969, 'NFS'], [0xff534d42, 'CIFS'], [0xfe534d42 - 2 ** 32, 'SMB2'], [0x65735546, 'FUSE'], [0x01021997, '9P']] as const)
    await assert.rejects(refuseNetworkFilesystem('/db', 'test', { platform: 'linux', statfs: async () => ({ type }) }), new RegExp(`^Error: The test database is on a ${name} filesystem`));
  assert.equal(NETWORK_FILESYSTEMS.get(0xfe534d42), 'SMB2', 'a negative f_type from a 32-bit kernel ABI is read unsigned');
  await refuseNetworkFilesystem('/db', 'test', { platform: 'linux', statfs: async () => ({ type: 0xef53 }) }); // ext4
  await refuseNetworkFilesystem('/db', 'test', { platform: 'darwin', statfs: async () => ({ type: 0x6969 }) });
  await refuseNetworkFilesystem('/db', 'test', { platform: 'win32', statfs: async () => { throw new Error('not read'); } });
});
