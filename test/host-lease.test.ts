import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { joinHostLease, NETWORK_FILESYSTEMS, refuseNetworkFilesystem, SERVER_LEASE } from '../packages/core/src/host-lease.ts';

// The shared setup checks of the SQLite-backed extensions (#927, #941). The store, auth and audit tests exercise them
// through each extension's activation; these pin the rules themselves.
async function database(t: test.TestContext): Promise<DatabaseSync> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-lease-'));
  const db = new DatabaseSync(join(dir, 'lease.sqlite'), { timeout: 2000 });
  db.exec('PRAGMA journal_mode=WAL');
  // Close before removing: Windows keeps an open SQLite (WAL) file's directory busy.
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return db;
}
const here = { hostname: () => 'web-1', bootId: async () => '11111111-1111-4111-8111-111111111111' };
const peer = (db: DatabaseSync, host: string, boot: string | null, expires: number) =>
  db.prepare('INSERT INTO t_servers(instance, host, boot, pid, heartbeat_at, expires_at) VALUES (?, ?, ?, 1, ?, ?)').run(`peer-${host}-${String(boot)}`, host, boot, Date.now(), expires);

test('a host lease refuses a live peer on another host, never one on this host, and ignores an expired one', async t => {
  const db = await database(t);
  const first = await joinHostLease(db, { table: 't_servers', what: 'test', probe: here });
  assert.equal(first.peers, 0);
  // Another container on this kernel: its own hostname, the same boot id.
  const container = await joinHostLease(db, { table: 't_servers', what: 'test', probe: { hostname: () => 'web-2', bootId: here.bootId } });
  assert.equal(container.peers, 1);
  container.close(); first.close();
  assert.equal((db.prepare('SELECT count(*) AS n FROM t_servers').get() as { n: number }).n, 0, 'close deletes the row');

  peer(db, 'gone', 'boot-gone', Date.now() - 1);
  const afterExpiry = await joinHostLease(db, { table: 't_servers', what: 'test', probe: here });
  assert.equal(afterExpiry.peers, 0, 'an expired lease is no peer, and is dropped');
  afterExpiry.close();

  peer(db, 'web-9', '22222222-2222-4222-8222-222222222222', Date.now() + SERVER_LEASE.ttlMs);
  await assert.rejects(joinHostLease(db, { table: 't_servers', what: 'test', probe: here }), /^Error: Another server on host "web-9" holds a live lease on this test database: a test database is served from one host only/);
  assert.equal((db.prepare('SELECT count(*) AS n FROM t_servers').get() as { n: number }).n, 1, 'a refused join leaves no row');
  // Expired by the clock the lease reads: the peer no longer counts.
  const later = await joinHostLease(db, { table: 't_servers', what: 'test', probe: here, now: () => Date.now() + SERVER_LEASE.ttlMs + 1 });
  later.close();
});

test('without a boot id on either side, a peer is compared by hostname', async t => {
  const db = await database(t);
  (await joinHostLease(db, { table: 't_servers', what: 'test', probe: here })).close();
  peer(db, 'mac', null, Date.now() + SERVER_LEASE.ttlMs);
  await assert.rejects(joinHostLease(db, { table: 't_servers', what: 'test', probe: { hostname: () => 'other-mac', bootId: async () => undefined } }), /Another server on host "mac"/);
  // A Linux joiner with a boot id against a peer without one: still by hostname.
  await assert.rejects(joinHostLease(db, { table: 't_servers', what: 'test', probe: here }), /Another server on host "mac"/);
  const same = await joinHostLease(db, { table: 't_servers', what: 'test', probe: { hostname: () => 'mac', bootId: async () => undefined } });
  assert.equal(same.peers, 1);
  same.close();
});

test('a host lease on a plain connection never ends a transaction someone else opened', async t => {
  const db = await database(t);
  db.exec('BEGIN; CREATE TABLE kept(x); INSERT INTO kept VALUES (1);');
  await assert.rejects(joinHostLease(db, { table: 't_servers', what: 'test', probe: here }), /within a transaction/);
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
