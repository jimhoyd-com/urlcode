// One serving process per store database: the server lock that refuses a second serving process (and frees itself
// when the first is killed), the declaration and schema fence between activations of one process, the operator
// commands' fence while a server runs, and the refused network filesystem. The lock is proved between real `node`
// child processes (test/process-child.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { ExtensionActivation } from '@jimhoyd/urlcode/extensions';
import { NETWORK_FILESYSTEMS, serverLockHeld } from '@jimhoyd/urlcode/sqlite';
import { STORE_SCHEMA_VERSION, addMember, createStore } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { openStoreDatabase } from '../src/database.ts';
import { cleanup } from './cleanup.ts';
import { answer, origin, pin, requestFor } from './direct.ts';
import { counts, execute, initialize, records } from './rows.ts';

const schema = { type: 'object', additionalProperties: false, required: ['title', 'balance'], properties: { title: { type: 'string', minLength: 1, maxLength: 40 }, status: { type: 'string', enum: ['open', 'done'] }, balance: { type: 'integer' } } };
const todos = { mount: '/api/todos', schema, defaults: { status: 'open', balance: 0 }, readOnlyProperties: ['balance'], transitions: { finish: { from: { status: 'open' }, set: { status: 'done' } } }, transfers: { move: { amount: 'balance' } } };
const v1 = { collections: { todos } };
/** The same collection with a tighter title: an older activation would keep writing titles it forbids. */
const v2 = { collections: { todos: { ...todos, schema: { ...schema, properties: { ...schema.properties, title: { ...schema.properties.title, maxLength: 5 } } } } } };
const members = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
const mounts = ['/api/todos'];
const REDECLARED = { error: { code: 'storage_unavailable', message: 'The collection was redeclared by a newer activation' } };

async function root(t: TestContext): Promise<{ root: string; database: string; activation: ExtensionActivation }> {
  const dir = await mkdtemp(join(tmpdir(), 'store-lock-'));
  cleanup(t, () => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(dir, 'app'));
  return { root: dir, database: join(dir, 'data', 'store.sqlite'), activation: { origin, target: 'node', projectSha256: pin, mounts, principalMounts: mounts, root: join(dir, 'app') } };
}
/** One store registration (its own connection, sharing this process's server lock) activated with `config`; closed by the test's cleanup. */
async function serve(t: TestContext, database: string, activation: ExtensionActivation, config: Record<string, unknown>, extra: Partial<Parameters<typeof createStore>[0]> = {}) {
  const store = createStore({ database, projectSha256: pin, ...extra });
  const instance = await store.registration.activate(config, activation);
  let open = true;
  const close = async () => { if (open) { open = false; await instance.close?.(); await store.close(); } };
  cleanup(t, close);
  const call = async (method: string, path: string, body?: unknown) => answer(await instance.handle!(requestFor(mounts, method, path, body === undefined ? {} : { body })));
  return { store, call, close, exports: store.exports };
}
const integrity = (database: string): unknown => { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare('PRAGMA integrity_check').get()!.integrity_check; } finally { db.close(); } };

/** A child `node` process serving the store (test/process-child.ts), driven one JSON line at a time. */
async function child(t: TestContext, database: string, activation: ExtensionActivation, config: Record<string, unknown>) {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--conditions=development', join(import.meta.dirname, 'process-child.ts'), JSON.stringify({ database, config, activation })], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<void>(resolve => { proc.once('exit', () => resolve()); });
  const kill = async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; } };
  cleanup(t, kill);
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<Record<string, unknown>> => {
    const line = await lines.next();
    if (line.done) throw new Error(`the child exited: ${stderr}`);
    return JSON.parse(line.value) as Record<string, unknown>;
  };
  const ready = await next();
  const send = (command: Record<string, unknown>): void => { proc.stdin.write(`${JSON.stringify(command)}\n`); };
  return {
    ready, next, send, kill,
    call: async (method: string, path: string, body?: unknown) => { send({ method, path, ...(body === undefined ? {} : { body }) }); return await next() as { status: number; body: Record<string, unknown> }; },
  };
}

/**
 * Waits, at most 10 s, until no process holds `database`'s server lock. Windows releases a terminated process's
 * locks after an OS-determined delay rather than at exit; elsewhere this returns at once.
 */
async function released(database: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (serverLockHeld(database)) {
    if (Date.now() > deadline) throw new Error('timed out after 10000 ms: the killed server\'s lock to be released');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('a second serving process is refused before it writes, and a restart after SIGKILL is accepted with the database intact', { timeout: 120_000 }, async t => {
  const { database, activation } = await root(t);
  const first = await child(t, database, activation, v1);
  assert.equal(first.ready.ready, true);
  assert.equal((await first.call('POST', '/api/todos', { title: 'one' })).status, 201);
  // Another server on the same database, even with another declaration, is refused and records nothing.
  const before = counts(database);
  const second = await child(t, database, activation, v2);
  assert.match(String(second.ready.error), /^Another process is already serving this store database \(.+store\.sqlite\): URLCode serves each database from one process/);
  await assert.rejects(serve(t, database, activation, v1), /^Error: Another process is already serving this store database/);
  assert.deepEqual(counts(database), before);
  assert.equal((await first.call('POST', '/api/todos', { title: 'two' })).status, 201, 'the first server kept serving');
  // Killed mid-burst: the OS drops its lock, and every committed write survives in an intact database.
  for (let i = 0; i < 50; i++) first.send({ method: 'POST', path: '/api/todos', body: { title: `burst ${i}` } });
  for (let i = 0; i < 5; i++) assert.equal((await first.next()).status, 201);
  await first.kill();
  await released(database);
  assert.equal(integrity(database), 'ok');
  const restarted = await child(t, database, activation, v1);
  assert.equal(restarted.ready.ready, true, 'no lease to expire: the restart is accepted at once');
  const titles = records(database, 'todos').map(record => record.title as string);
  assert.deepEqual(titles.slice(0, 7), ['one', 'two', 'burst 0', 'burst 1', 'burst 2', 'burst 3', 'burst 4']);
  assert.equal((await restarted.call('POST', '/api/todos', { title: 'three' })).status, 201);
  assert.equal(records(database, 'todos').length, titles.length + 1);
});

test('two activations in one process with different declarations (a reload overlap): the older one reads but every write path is refused and writes nothing', async t => {
  const { database, activation } = await root(t);
  const older = await serve(t, database, activation, v1);
  const first = await older.call('POST', '/api/todos', { title: 'one' });
  assert.equal(first.status, 201);
  const second = await older.call('POST', '/api/todos', { title: 'two' });
  const id = first.body!.id as string, other = second.body!.id as string;
  const newer = await serve(t, database, activation, v2);
  const before = counts(database);
  for (const [method, path, body] of [['POST', '/api/todos', { title: 'longer title' }], ['PATCH', `/api/todos/${id}`, { title: 'patched' }], ['PUT', `/api/todos/${id}`, { title: 'put' }], ['DELETE', `/api/todos/${id}`], ['POST', `/api/todos/${id}/finish`], ['POST', '/api/todos/transfers/move', { from: id, to: other, amount: 1 }]] as const) {
    const refused = await older.call(method, path, body);
    assert.deepEqual([refused.status, refused.body], [503, REDECLARED], `${method} ${path}`);
  }
  // The records export and host transactions are write paths too; a transaction that only reads is not refused.
  await assert.rejects(older.exports.records('todos').create(null, { title: 'x' }), { status: 503, message: REDECLARED.error.message });
  assert.throws(() => older.exports.transaction(tx => tx.records('todos').create(null, { title: 'x' })), { status: 503 });
  assert.equal(older.exports.transaction(tx => tx.records('todos').list(null).total), 2);
  assert.deepEqual(counts(database), before, 'nothing was written');
  // Reads keep working.
  const listed = await older.call('GET', '/api/todos');
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body!.items as { title: string }[]).map(item => item.title), ['one', 'two']);
  assert.equal((await older.call('GET', `/api/todos/${id}`)).status, 200);
  // The newest activation writes; the older one closing changes nothing for it.
  assert.equal((await newer.call('POST', '/api/todos', { title: 'third' })).status, 201);
  await older.close();
  assert.equal((await newer.call('POST', '/api/todos', { title: 'four' })).status, 201);
  assert.deepEqual(records(database, 'todos').map(record => record.title), ['one', 'two', 'third', 'four']);
});

test('two activations in one process with the same declaration both write, and a schema version change fences both', async t => {
  const { database, activation } = await root(t);
  const a = await serve(t, database, activation, v1), b = await serve(t, database, activation, { collections: { todos: { ...todos } } });
  assert.equal((await a.call('POST', '/api/todos', { title: 'from a' })).status, 201);
  assert.equal((await b.call('POST', '/api/todos', { title: 'from b' })).status, 201);
  assert.equal((await a.call('POST', '/api/todos', { title: 'a again' })).status, 201, 'b\'s activation recorded the same fingerprint');
  // A newer release migrated the file: this process's SQL is no longer the file's.
  execute(database, `PRAGMA user_version=${STORE_SCHEMA_VERSION + 1}`);
  assert.deepEqual((await a.call('POST', '/api/todos', { title: 'stale' })).body, REDECLARED);
  assert.equal((await b.call('GET', '/api/todos')).status, 200);
  execute(database, `PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
  assert.equal((await b.call('POST', '/api/todos', { title: 'from b' })).status, 201);
});

test('an operator command is refused while a server declares the collection differently, and proceeds once none runs', async t => {
  const { database, activation } = await root(t);
  const config = { collections: { ...v1.collections, members } };
  const other = { members: { ...members, maxRecords: 5 } } as unknown as Record<string, CollectionSpec>;
  // A server in another process: the command sees its lock through the file.
  const elsewhere = await child(t, database, activation, config);
  assert.equal(elsewhere.ready.ready, true);
  await addMember(database, { collections: { members } as unknown as Record<string, CollectionSpec>, collection: 'members', principal: 'ann' });
  await assert.rejects(addMember(database, { collections: other, collection: 'members', principal: 'bob' }), { status: 503, message: /Collection members: the serving process declares it differently/ });
  await elsewhere.kill();
  await released(database);
  assert.equal((await addMember(database, { collections: other, collection: 'members', principal: 'bob' })).changed, true);
  // A server in this process.
  const served = await serve(t, database, activation, config);
  await assert.rejects(addMember(database, { collections: other, collection: 'members', principal: 'cy' }), { status: 503, message: /the serving process declares it differently/ });
  await served.close();
  assert.equal((await addMember(database, { collections: other, collection: 'members', principal: 'cy' })).changed, true);
});

test('a database directory on a network filesystem is refused on Linux before the lock or the database is touched', async t => {
  const { database, activation } = await root(t);
  for (const [type, name] of [[0x6969, 'NFS'], [0xff534d42, 'CIFS'], [0xfe534d42 - 2 ** 32, 'SMB2'], [0x65735546, 'FUSE']] as const) {
    const probe = { platform: 'linux' as const, statfs: async () => ({ type }) };
    await assert.rejects(serve(t, database, activation, v1, { probe }), new RegExp(`^Error: The store database is on a ${name} filesystem`));
  }
  assert.equal(NETWORK_FILESYSTEMS.get(0xfe534d42), 'SMB2', 'a negative f_type from a 32-bit kernel ABI is read unsigned');
  const local = { platform: 'linux' as const, statfs: async () => ({ type: 0xef53 }) }; // ext4
  const served = await serve(t, database, activation, v1, { probe: local });
  assert.equal((await served.call('POST', '/api/todos', { title: 'local' })).status, 201);
  await served.close();
  // The operator commands open the database through the same check.
  await assert.rejects(openStoreDatabase(database, { probe: { platform: 'linux', statfs: async () => ({ type: 0x6969 }) } }), /NFS filesystem/);
});

test('upgrading a version 4 or 5 database drops the multi-process lease tables, and the drain marker with the outbox', async t => {
  const { database } = await root(t);
  const upgraded = async (): Promise<void> => {
    (await openStoreDatabase(database)).close();
    const db = new DatabaseSync(database);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, STORE_SCHEMA_VERSION);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('store_servers', 'store_audit_drain', 'store_audit_outbox')").all(), []);
      assert.equal(db.prepare('SELECT count(*) AS n FROM store_audit_events').get()!.n, 0);
    } finally { db.close(); }
  };
  await initialize(database);
  // Back to the version 4 shape, as that release left it.
  const outbox = `DROP TABLE store_audit_events; DROP TABLE store_audit_tap;
    CREATE TABLE store_audit_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, collection TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL CHECK (json_valid(event)));`;
  execute(database, `DROP TABLE store_declarations; ${outbox}
    CREATE TABLE store_audit_drain(id INTEGER PRIMARY KEY CHECK (id = 1), drained_at INTEGER NOT NULL);
    INSERT INTO store_audit_drain(id, drained_at) VALUES (1, 1234); PRAGMA user_version=4;`);
  await upgraded();
  // The version 5 shape: the host lease table and the drain lease.
  execute(database, `${outbox} CREATE TABLE store_servers(instance TEXT PRIMARY KEY, host TEXT NOT NULL, boot TEXT, pid INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID;
    INSERT INTO store_servers VALUES ('gone', 'web-1', NULL, 1, 1, 1);
    CREATE TABLE store_audit_drain(id INTEGER PRIMARY KEY CHECK (id = 1), drained_at INTEGER, holder TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
    INSERT INTO store_audit_drain VALUES (1, 1234, 'gone', 99); PRAGMA user_version=5;`);
  await upgraded();
});
