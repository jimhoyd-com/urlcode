import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { holdServerLock, NETWORK_FILESYSTEMS, refuseNetworkFilesystem, serverLockHeld, serverLockPath } from '../packages/core/src/server-lock.ts';

// One serving process per database: the server lock every SQLite-backed extension (store, auth, audit) takes before it
// serves. The store, auth and audit tests exercise it through each extension's activation; these pin the lock itself
// against a real second process, including one killed with SIGKILL.

async function directory(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-server-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

/** Another `node` process that takes `database`'s server lock and prints the outcome as one JSON line, then waits. */
async function holder(t: test.TestContext, database: string): Promise<{ outcome: { held?: true; error?: string }; kill(): Promise<void> }> {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'packages', 'core', 'src', 'server-lock.ts')).href;
  const code = `const { holdServerLock } = await import(${JSON.stringify(module)});
try { await holdServerLock(${JSON.stringify(database)}, 'test'); console.log(JSON.stringify({ held: true })); }
catch (error) { console.log(JSON.stringify({ error: error.message })); process.exit(0); }
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } };
  t.after(kill);
  const line = await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next();
  if (line.done) throw new Error('the holder exited before answering');
  return { outcome: JSON.parse(line.value) as { held?: true; error?: string }, kill };
}

test('a second process is refused while one holds the lock, and takes it once the holder is killed (SIGKILL)', async t => {
  const database = join(await directory(t), 'data', 'site.sqlite');
  assert.equal(serverLockHeld(database), false, 'never served: no lock file');
  const first = await holder(t, database);
  assert.deepEqual(first.outcome, { held: true });
  assert.equal(serverLockHeld(database), true);
  await assert.rejects(holdServerLock(database, 'test'), /^Error: Another process is already serving this test database \(.+site\.sqlite\): URLCode serves each database from one process/);
  const second = await holder(t, database);
  assert.match(String(second.outcome.error), /^Another process is already serving this test database/);
  // The operating system drops the lock of a killed process: no heartbeat, no expiry to wait for.
  await first.kill();
  assert.equal(serverLockHeld(database), false);
  const lock = await holdServerLock(database, 'test');
  assert.equal(serverLockHeld(database), true);
  assert.match(String((await holder(t, database)).outcome.error), /Another process is already serving/);
  lock.release();
  assert.deepEqual((await holder(t, database)).outcome, { held: true }, 'a released lock is free for another process');
});

test('holders in one process share the lock (a dev reload), and it is private and stays beside the database', async t => {
  const dir = await directory(t), database = join(dir, 'data', 'site.sqlite');
  const a = await holdServerLock(database, 'test'), b = await holdServerLock(database, 'test');
  assert.equal(a.path, serverLockPath(database));
  assert.equal(a.path, b.path);
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dir, 'data'))).mode & 0o777, 0o700);
    assert.equal((await stat(a.path)).mode & 0o777, 0o600);
  }
  a.release();
  a.release(); // Idempotent: one holder's release never drops another's share.
  assert.match(String((await holder(t, database)).outcome.error), /Another process is already serving/, 'b still holds it');
  b.release();
  assert.equal(serverLockHeld(database), false);
  await stat(a.path); // The file stays: deleting it could let two processes lock two different files.
});

test('a database directory on a network filesystem is refused on Linux and not checked elsewhere', async () => {
  for (const [type, name] of [[0x6969, 'NFS'], [0xff534d42, 'CIFS'], [0xfe534d42 - 2 ** 32, 'SMB2'], [0x65735546, 'FUSE'], [0x01021997, '9P']] as const)
    await assert.rejects(refuseNetworkFilesystem('/db', 'test', { platform: 'linux', statfs: async () => ({ type }) }), new RegExp(`^Error: The test database is on a ${name} filesystem`));
  assert.equal(NETWORK_FILESYSTEMS.get(0xfe534d42), 'SMB2', 'a negative f_type from a 32-bit kernel ABI is read unsigned');
  await refuseNetworkFilesystem('/db', 'test', { platform: 'linux', statfs: async () => ({ type: 0xef53 }) }); // ext4
  await refuseNetworkFilesystem('/db', 'test', { platform: 'darwin', statfs: async () => ({ type: 0x6969 }) });
  await refuseNetworkFilesystem('/db', 'test', { platform: 'win32', statfs: async () => { throw new Error('not read'); } });
});

test('the lock is refused before it is taken on a network filesystem', async t => {
  const database = join(await directory(t), 'site.sqlite');
  await assert.rejects(holdServerLock(database, 'test', { platform: 'linux', statfs: async () => ({ type: 0x6969 }) }), /on a NFS filesystem/);
  assert.equal(serverLockHeld(database), false);
});
