import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { holdServerLock, NETWORK_FILESYSTEMS, refuseNetworkFilesystem, serverLockHeld, serverLockPath } from '../packages/core/src/server-lock.ts';

// One serving process per database: the server lock every SQLite-backed extension (store, auth) takes before it
// serves. The store and auth tests exercise it through each extension's activation; these pin the lock itself
// against a real second process, including one killed with SIGKILL (TerminateProcess on Windows).
//
// Every wait on a child is bounded (`within`), so a platform difference fails with the child's stderr instead of
// hanging the file. Cleanups run newest first, so a child is killed before its directory is removed: Windows cannot
// delete a file another process holds open.

const CHILD_MS = 20_000;
/** `promise`, or a rejection naming `what` once `ms` pass. The timer never keeps the process alive. */
function within<T>(promise: Promise<T>, what: string, ms = CHILD_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms); timer.unref(); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
/** One cleanup stack per test, run newest first. */
function stack(t: test.TestContext): (close: () => unknown) => void {
  const closers: (() => unknown)[] = [];
  t.after(async () => { while (closers.length) await closers.pop()!(); });
  return close => { closers.push(close); };
}
async function directory(defer: (close: () => unknown) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-server-lock-'));
  defer(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}
/** Polls `check` until it is true, for at most `ms`. */
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Another `node` process that takes `database`'s server lock and prints the outcome as one JSON line. A refused child
 * exits once the line is written; a holder waits until it is killed. stdout is read to its end and stderr is kept for
 * the failure message.
 */
async function holder(defer: (close: () => unknown) => void, database: string): Promise<{ outcome: { held?: true; error?: string }; kill(): Promise<void> }> {
  const module = pathToFileURL(join(import.meta.dirname, '..', 'packages', 'core', 'src', 'server-lock.ts')).href;
  const code = `const { holdServerLock } = await import(${JSON.stringify(module)});
const say = (value, then) => process.stdout.write(JSON.stringify(value) + '\\n', then);
try { await holdServerLock(${JSON.stringify(database)}, 'test'); say({ held: true }, () => {}); setInterval(() => {}, 1000); }
catch (error) { say({ error: error.message }, () => process.exit(0)); }`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await within(exited, `the holder (pid ${String(child.pid)}) to exit after SIGKILL`);
  };
  defer(kill);
  const line = await within(new Promise<string>((resolve, reject) => {
    const look = (): void => { const end = stdout.indexOf('\n'); if (end >= 0) resolve(stdout.slice(0, end)); };
    child.stdout.on('data', look);
    void exited.then(() => { look(); reject(new Error('the holder exited before answering')); });
  }), 'the holder to answer').catch((error: unknown) => { throw new Error(`${(error as Error).message}\nstderr: ${stderr}`); });
  return { outcome: JSON.parse(line) as { held?: true; error?: string }, kill };
}

test('a second process is refused while one holds the lock, and takes it once the holder is killed (SIGKILL)', { timeout: 120_000 }, async t => {
  const defer = stack(t);
  const database = join(await directory(defer), 'data', 'site.sqlite');
  assert.equal(serverLockHeld(database), false, 'never served: no lock file');
  const first = await holder(defer, database);
  assert.deepEqual(first.outcome, { held: true });
  assert.equal(serverLockHeld(database), true);
  await assert.rejects(holdServerLock(database, 'test'), /^Error: Another process is already serving this test database \(.+site\.sqlite\): the bundled test serves its database from one process/);
  const second = await holder(defer, database);
  assert.match(String(second.outcome.error), /^Another process is already serving this test database/);
  // The operating system drops the lock of a killed process: no heartbeat, no expiry to wait for. Windows releases a
  // terminated process's locks after an OS-determined delay rather than at exit, hence the bounded poll.
  await first.kill();
  await until(() => !serverLockHeld(database), 'the killed holder\'s lock to be released');
  const lock = await holdServerLock(database, 'test');
  defer(() => { lock.release(); });
  assert.equal(serverLockHeld(database), true);
  assert.match(String((await holder(defer, database)).outcome.error), /Another process is already serving/);
  lock.release();
  assert.deepEqual((await holder(defer, database)).outcome, { held: true }, 'a released lock is free for another process');
});

test('holders in one process share the lock (a dev reload), and it is private and stays beside the database', { timeout: 120_000 }, async t => {
  const defer = stack(t);
  const dir = await directory(defer), database = join(dir, 'data', 'site.sqlite');
  const a = await holdServerLock(database, 'test'), b = await holdServerLock(database, 'test');
  defer(() => { a.release(); b.release(); });
  assert.equal(a.path, serverLockPath(database));
  assert.equal(a.path, b.path);
  if (process.platform !== 'win32') { // Windows has no POSIX mode bits to check.
    assert.equal((await stat(join(dir, 'data'))).mode & 0o777, 0o700);
    assert.equal((await stat(a.path)).mode & 0o777, 0o600);
  }
  a.release();
  a.release(); // Idempotent: one holder's release never drops another's share.
  assert.match(String((await holder(defer, database)).outcome.error), /Another process is already serving/, 'b still holds it');
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
  const database = join(await directory(stack(t)), 'site.sqlite');
  await assert.rejects(holdServerLock(database, 'test', { platform: 'linux', statfs: async () => ({ type: 0x6969 }) }), /on a NFS filesystem/);
  assert.equal(serverLockHeld(database), false);
});
