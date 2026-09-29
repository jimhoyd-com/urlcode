// urlcode-store backup (#859): a consistent online copy through SQLite's backup API, beside a serving server, into a
// new 0600 file that must not exist, checked as a store database before it appears.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as sqlite from 'node:sqlite';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { STORE_SCHEMA_VERSION, backupStore, storeExtension } from '../src/index.ts';
import { cleanup } from './cleanup.ts';
import { initialize, records, seed } from './rows.ts';

const skip = typeof sqlite.backup !== 'function' && 'node:sqlite backup() needs Node 22.16 or newer';
const origin = 'https://backup.example.test', json = { 'content-type': 'application/json' };
const todos = { mount: '/api/todos', schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 } } } };
const cliPath = join(import.meta.dirname, '..', 'src', 'cli.ts');
const runCli = (...args: string[]) => promisify(execFile)(process.execPath, ['--conditions=development', cliPath, ...args]);
const cliFailure = (...args: string[]) => runCli(...args).then(() => null, (error: { code: number; stderr: string }) => error);
const posix = process.platform !== 'win32';

async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'store-backup-'));
  // Registered first, so it unwinds last: after every server and handle below is closed (Windows cannot remove an open file).
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, 'app'));
  await mkdir(join(root, 'backups'), { mode: 0o700 });
  return root;
}
async function serve(t: TestContext, root: string) {
  const project = join(root, 'app'), database = join(root, 'data', 'store.sqlite');
  await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { store: { version: '1', config: { collections: { todos } } } }, routes: { '/api/todos/*': { extension: 'store', methods: ['GET', 'POST'] } } }));
  const app = await startServer({ project, origin, port: 0, log: () => {}, extensions: [storeExtension({ database, projectSha256: await inspectExtensionRevision(project) })] });
  cleanup(t, () => app.close());
  return { database, post: (title: string) => fetch(`http://127.0.0.1:${app.address.port}/api/todos`, { method: 'POST', headers: json, body: JSON.stringify({ title }) }) };
}
/** Nothing but the named entries: a failed or finished backup leaves no temporary directory behind. */
const entries = async (directory: string) => (await readdir(directory)).sort();

test('backup copies the database online while the server keeps serving, into a new 0600 file that opens as a store', { skip }, async t => {
  const root = await temp(t);
  const { database, post } = await serve(t, root);
  for (const title of ['a', 'b']) assert.equal((await post(title)).status, 201);
  const destination = join(root, 'backups', 'store-1.sqlite');
  const { stdout } = await runCli('backup', '--database', database, '--destination', destination);
  const result = JSON.parse(stdout) as { format: string; schemaVersion: number; bytes: number; destination: string };
  assert.deepEqual({ ...result, bytes: 0 }, { format: 'urlcode-store-sqlite', schemaVersion: STORE_SCHEMA_VERSION, bytes: 0, destination: join(await realpath(join(root, 'backups')), 'store-1.sqlite') }, 'the resolved destination');
  assert.equal(result.bytes, (await stat(destination)).size);
  if (posix) assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(records(destination, 'todos').map(record => record.title), ['a', 'b']);
  assert.equal((await post('c')).status, 201, 'the server kept writing');
  assert.deepEqual(records(destination, 'todos').map(record => record.title), ['a', 'b'], 'the copy is a snapshot');
  assert.deepEqual(await entries(join(root, 'backups')), ['store-1.sqlite']);
  // The copy is a database the store opens as it is: its identity and schema version survive.
  const restored = join(root, 'backups', 'restored.sqlite');
  await backupStore({ database: destination, destination: restored });
  assert.deepEqual(records(restored, 'todos').map(record => record.title), ['a', 'b']);
});

test('backup of a database no server has open (no -wal or -shm) works the same', { skip }, async t => {
  const root = await temp(t), database = join(root, 'data', 'store.sqlite');
  await seed(database, 'todos', [{ id: 'x1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', title: 'kept' }]);
  const destination = join(root, 'backups', 'offline.sqlite');
  const result = await backupStore({ database, destination });
  assert.equal(result.schemaVersion, STORE_SCHEMA_VERSION);
  assert.deepEqual(records(destination, 'todos').map(record => record.title), ['kept']);
});

test('backup refuses an existing destination, a foreign or shared file, relative paths and misplaced options', { skip }, async t => {
  const root = await temp(t), database = join(root, 'data', 'store.sqlite'), backups = join(root, 'backups');
  await initialize(database);
  const existing = join(backups, 'existing.sqlite');
  await writeFile(existing, 'keep me', { mode: 0o600 });
  await assert.rejects(backupStore({ database, destination: existing }), /The backup destination already exists/);
  assert.equal(await readFile(existing, 'utf8'), 'keep me', 'an existing file is never replaced');
  await assert.rejects(backupStore({ database, destination: database }), /cannot replace its source/);
  await assert.rejects(backupStore({ database: 'data/store.sqlite', destination: join(backups, 'x.sqlite') }), /must be absolute paths/);
  await assert.rejects(backupStore({ database, destination: 'x.sqlite' }), /must be absolute paths/);
  await assert.rejects(backupStore({ database: join(root, 'data', 'missing.sqlite'), destination: join(backups, 'x.sqlite') }), /does not exist/);
  await assert.rejects(backupStore({ database, destination: join(root, 'nowhere', 'x.sqlite') }), /directory does not exist/);
  // A SQLite file that is not a store database.
  const foreign = join(root, 'data', 'foreign.sqlite');
  const db = new sqlite.DatabaseSync(foreign);
  try { db.exec('CREATE TABLE other(x)'); } finally { db.close(); }
  await chmod(foreign, 0o600);
  await assert.rejects(backupStore({ database: foreign, destination: join(backups, 'x.sqlite') }), /Not a store database/);
  if (posix) {
    await chmod(database, 0o644);
    await assert.rejects(backupStore({ database, destination: join(backups, 'x.sqlite') }), /private regular file/);
    await chmod(database, 0o600);
  }
  assert.deepEqual(await entries(backups), ['existing.sqlite'], 'no refusal leaves a temporary directory or partial copy');
  // The CLI names what is missing or misplaced, and exits 1.
  const noDestination = await cliFailure('backup', '--database', database);
  assert.equal(noDestination?.code, 1); assert.match(noDestination!.stderr, /--database and --destination are required/);
  assert.match((await cliFailure('backup', '--database', database, '--destination', join(backups, 'y.sqlite'), '--collection', 'todos'))!.stderr, /--collection does not apply to backup/);
  assert.match((await cliFailure('ownerless', '--database', database, '--collection', 'todos', '--destination', join(backups, 'y.sqlite')))!.stderr, /--destination applies to backup only/);
  assert.match((await cliFailure('backup', '--database', database, '--destination', existing))!.stderr, /urlcode-store: The backup destination already exists/);
  assert.match((await runCli('--help')).stdout, /urlcode-store backup --database/);
});
