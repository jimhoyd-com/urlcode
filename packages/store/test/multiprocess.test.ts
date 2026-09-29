// Several serving processes on one store database (#927): the declaration and schema fence, the refused setups (a
// network filesystem, a live peer on another host) and the single audit drainer. The fence is proved both between two
// registrations in this process (two connections) and between real `node` child processes.
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
import { createAudit } from '@jimhoyd/urlcode-audit';
import type { Audit } from '@jimhoyd/urlcode-audit';
import { STORE_SCHEMA_VERSION, addMember, createStore } from '../src/index.ts';
import type { CollectionSpec } from '../src/index.ts';
import { openStoreDatabase } from '../src/database.ts';
import { NETWORK_FILESYSTEMS, SERVER_LEASE, refuseNetworkFilesystem } from '../src/topology.ts';
import { cleanup } from './cleanup.ts';
import { answer, origin, pin, requestFor } from './direct.ts';
import { counts, execute, initialize, outbox, records } from './rows.ts';

const schema = { type: 'object', additionalProperties: false, required: ['title', 'balance'], properties: { title: { type: 'string', minLength: 1, maxLength: 40 }, status: { type: 'string', enum: ['open', 'done'] }, balance: { type: 'integer' } } };
const todos = { mount: '/api/todos', schema, defaults: { status: 'open', balance: 0 }, readOnlyProperties: ['balance'], transitions: { finish: { from: { status: 'open' }, set: { status: 'done' } } }, transfers: { move: { amount: 'balance' } } };
const v1 = { collections: { todos } };
/** The same collection with a tighter title: an older process would keep writing titles it forbids. */
const v2 = { collections: { todos: { ...todos, schema: { ...schema, properties: { ...schema.properties, title: { ...schema.properties.title, maxLength: 5 } } } } } };
const mounts = ['/api/todos'];
const REDECLARED = { error: { code: 'storage_unavailable', message: 'The collection was redeclared by another process' } };

async function root(t: TestContext): Promise<{ root: string; database: string; activation: ExtensionActivation }> {
  const dir = await mkdtemp(join(tmpdir(), 'store-multi-'));
  cleanup(t, () => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(dir, 'app'));
  return { root: dir, database: join(dir, 'data', 'store.sqlite'), activation: { origin, target: 'node', projectSha256: pin, mounts, principalMounts: mounts, root: join(dir, 'app') } };
}
/** One store registration (its own connection) activated with `config`; closed by the test's cleanup. */
async function serve(t: TestContext, database: string, activation: ExtensionActivation, config: Record<string, unknown>, extra: Partial<Parameters<typeof createStore>[0]> = {}) {
  const store = createStore({ database, projectSha256: pin, ...extra });
  const warnings: string[] = [];
  const instance = await store.registration.activate(config, { ...activation, warn: message => { warnings.push(message); } });
  let open = true;
  const close = async () => { if (open) { open = false; await instance.close?.(); await store.close(); } };
  cleanup(t, close);
  const call = async (method: string, path: string, body?: unknown) => answer(await instance.handle!(requestFor(mounts, method, path, body === undefined ? {} : { body })));
  return { store, call, close, warnings, exports: store.exports };
}
const until = async (check: () => boolean, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
};

test('two activations with different declarations on one database: the older one reads but every write path is refused and writes nothing', async t => {
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

test('two activations with the same declaration both write, and a schema version change fences both', async t => {
  const { database, activation } = await root(t);
  const a = await serve(t, database, activation, v1), b = await serve(t, database, activation, { collections: { todos: { ...todos } } });
  assert.equal((await a.call('POST', '/api/todos', { title: 'from a' })).status, 201);
  assert.equal((await b.call('POST', '/api/todos', { title: 'from b' })).status, 201);
  assert.equal((await a.call('POST', '/api/todos', { title: 'a again' })).status, 201, 'b\'s activation recorded the same fingerprint');
  assert.match(b.warnings.join('\n'), /another serving process uses this store database: throttle policies and origin caches are per process/);
  assert.deepEqual(a.warnings, [], 'the first process had no live peer when it activated');
  // A newer release migrated the file: the running processes' SQL is no longer the file's.
  execute(database, `PRAGMA user_version=${STORE_SCHEMA_VERSION + 1}`);
  assert.deepEqual((await a.call('POST', '/api/todos', { title: 'stale' })).body, REDECLARED);
  assert.equal((await b.call('GET', '/api/todos')).status, 200);
  execute(database, `PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
  assert.equal((await b.call('POST', '/api/todos', { title: 'from b' })).status, 201);
});

/** A child `node` process serving the store (test/process-child.ts), driven one JSON line at a time. */
async function child(t: TestContext, database: string, activation: ExtensionActivation, config: Record<string, unknown>, probe?: { bootId?: string; hostname?: string }) {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--conditions=development', join(import.meta.dirname, 'process-child.ts'), JSON.stringify({ database, config, activation, probe })], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<void>(resolve => { proc.once('exit', () => resolve()); });
  cleanup(t, async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await exited; } });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<Record<string, unknown>> => {
    const line = await lines.next();
    if (line.done) throw new Error(`the child exited: ${stderr}`);
    return JSON.parse(line.value) as Record<string, unknown>;
  };
  const ready = await next();
  const send = async (command: Record<string, unknown>) => { proc.stdin.write(`${JSON.stringify(command)}\n`); return next(); };
  return {
    ready,
    call: (method: string, path: string, body?: unknown) => send({ method, path, ...(body === undefined ? {} : { body }) }) as Promise<{ status: number; body: Record<string, unknown> }>,
    async close() { assert.deepEqual(await send({ op: 'close' }), { closed: true }); await exited; },
  };
}

test('across real processes: the same declaration writes in both, a redeclaring process fences the older ones, reads keep working', async t => {
  const { database, activation } = await root(t);
  const one = await child(t, database, activation, v1), two = await child(t, database, activation, v1);
  assert.equal(one.ready.ready, true); assert.equal(two.ready.ready, true);
  assert.match((two.ready.warnings as string[]).join('\n'), /another serving process uses this store database/);
  assert.equal((await one.call('POST', '/api/todos', { title: 'one' })).status, 201);
  assert.equal((await two.call('POST', '/api/todos', { title: 'two' })).status, 201);
  // A blue/green candidate on the next declaration starts beside them.
  const candidate = await child(t, database, activation, v2);
  assert.equal(candidate.ready.ready, true);
  const before = counts(database);
  for (const retiring of [one, two]) {
    const refused = await retiring.call('POST', '/api/todos', { title: 'much too long' });
    assert.deepEqual([refused.status, refused.body], [503, REDECLARED]);
    const listed = await retiring.call('GET', '/api/todos');
    assert.deepEqual([listed.status, (listed.body.items as { title: string }[]).map(item => item.title)], [200, ['one', 'two']]);
  }
  assert.deepEqual(counts(database), before, 'the retiring processes wrote nothing');
  assert.equal((await candidate.call('POST', '/api/todos', { title: 'three' })).status, 201);
  await one.close(); await two.close();
  assert.equal((await candidate.call('POST', '/api/todos', { title: 'four' })).status, 201);
  await candidate.close();
  assert.deepEqual(records(database, 'todos').map(record => record.title), ['one', 'two', 'three', 'four']);
});

test('across real processes: a live peer on another host (another boot id) refuses activation; one on this host does not', async t => {
  const { database, activation } = await root(t);
  const here = await child(t, database, activation, v1, { bootId: '11111111-1111-4111-8111-111111111111', hostname: 'web-1' });
  assert.equal(here.ready.ready, true);
  // Another container on the same kernel: its own hostname, the same boot id.
  const container = await child(t, database, activation, v1, { bootId: '11111111-1111-4111-8111-111111111111', hostname: 'web-2' });
  assert.equal(container.ready.ready, true);
  const elsewhere = await child(t, database, activation, v1, { bootId: '22222222-2222-4222-8222-222222222222', hostname: 'web-1' });
  assert.match(String(elsewhere.ready.error), /^Another server on host "web-[12]" holds a live lease on this store database: a store database is served from one host only/);
  await container.close(); await here.close();
});

test('a peer lease from another host counts only while it is live, and a host without a boot id is compared by hostname', async t => {
  const { database, activation } = await root(t);
  await initialize(database);
  const lease = (host: string, boot: string | null, expires: number) => execute(database, `INSERT INTO store_servers(instance, host, boot, pid, heartbeat_at, expires_at) VALUES ('peer-${host}', '${host}', ${boot === null ? 'NULL' : `'${boot}'`}, 1, ${Date.now()}, ${expires})`);
  lease('gone', 'boot-gone', Date.now() - 1);
  const served = await serve(t, database, activation, v1, { probe: { bootId: async () => 'boot-here', hostname: () => 'here' } });
  assert.deepEqual(served.warnings, [], 'an expired lease is no peer');
  await served.close();
  lease('mac', null, Date.now() + SERVER_LEASE.ttlMs);
  await assert.rejects(serve(t, database, activation, v1, { probe: { bootId: async () => undefined, hostname: () => 'other-mac' } }), /Another server on host "mac"/);
  const same = await serve(t, database, activation, v1, { probe: { bootId: async () => undefined, hostname: () => 'mac' } });
  assert.match(same.warnings.join('\n'), /another serving process uses this store database/);
});

test('a database directory on a network filesystem is refused on Linux and not checked elsewhere', async t => {
  const { database, activation } = await root(t);
  for (const [type, name] of [[0x6969, 'NFS'], [0xff534d42, 'CIFS'], [0xfe534d42 - 2 ** 32, 'SMB2'], [0x65735546, 'FUSE']] as const) {
    const probe = { platform: 'linux' as const, statfs: async () => ({ type }) };
    await assert.rejects(serve(t, database, activation, v1, { probe }), new RegExp(`^Error: The store database is on a ${name} filesystem`));
  }
  assert.equal(NETWORK_FILESYSTEMS.get(0xfe534d42), 'SMB2', 'a negative f_type from a 32-bit kernel ABI is read unsigned');
  const local = { platform: 'linux' as const, statfs: async () => ({ type: 0xef53 }) }; // ext4
  assert.equal((await (await serve(t, database, activation, v1, { probe: local })).call('POST', '/api/todos', { title: 'local' })).status, 201);
  await refuseNetworkFilesystem('/anywhere', 'store', { platform: 'darwin', statfs: async () => ({ type: 0x6969 }), hostname: () => 'x', bootId: async () => undefined });
  // The operator commands open the database through the same check.
  await assert.rejects(openStoreDatabase(database, { probe: { platform: 'linux', statfs: async () => ({ type: 0x6969 }), hostname: () => 'x', bootId: async () => undefined } }), /NFS filesystem/);
});

test('an operator command is refused while a live server declares the collection differently, and proceeds once none is live', async t => {
  const { database, activation } = await root(t);
  const members = { membership: true, key: 'userId', schema: { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: 'string', maxLength: 128 } } } };
  const served = await serve(t, database, activation, { collections: { ...v1.collections, members } });
  await addMember(database, { collections: { members } as unknown as Record<string, CollectionSpec>, collection: 'members', principal: 'ann' });
  const other = { members: { ...members, maxRecords: 5 } } as unknown as Record<string, CollectionSpec>;
  await assert.rejects(addMember(database, { collections: other, collection: 'members', principal: 'bob' }), { status: 503, message: /Collection members: the serving process declares it differently/ });
  await served.close();
  assert.equal((await addMember(database, { collections: other, collection: 'members', principal: 'bob' })).changed, true);
});

test('upgrading a version 4 database keeps when the drain last kept up and starts with no drain lease', async t => {
  const { database } = await root(t);
  await initialize(database);
  // Back to the version 4 shape, as the previous release left it.
  execute(database, `DROP TABLE store_declarations; DROP TABLE store_servers; DROP TABLE store_audit_drain;
    CREATE TABLE store_audit_drain(id INTEGER PRIMARY KEY CHECK (id = 1), drained_at INTEGER NOT NULL);
    INSERT INTO store_audit_drain(id, drained_at) VALUES (1, 1234); PRAGMA user_version=4;`);
  (await openStoreDatabase(database)).close();
  const db = new DatabaseSync(database);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, STORE_SCHEMA_VERSION);
    assert.deepEqual({ ...db.prepare('SELECT drained_at, holder, lease_until FROM store_audit_drain').get() }, { drained_at: 1234, holder: null, lease_until: 0 });
  } finally { db.close(); }
});

test('one process drains the audit outbox: a peer waits while the lease is live and takes over once it expires or its holder closes', async t => {
  const { root: dir, database, activation } = await root(t);
  const audited = { collections: { todos: { ...todos, audit: true } } };
  const audits: Audit[] = [];
  const auditFor = async (name: string) => {
    const audit = await createAudit({ projectSha256: pin, database: join(dir, 'data', `${name}.sqlite`), onDeliveryError: () => {} });
    cleanup(t, () => audit.close());
    await audit.registration.activate({}, { ...activation, mounts: [] });
    audits.push(audit);
    return audit;
  };
  const delivered = async (audit: Audit) => (await audit.exports.query({ limit: 100 })).events.length;
  await initialize(database);
  // Another process holds the drain lease.
  execute(database, `INSERT INTO store_audit_drain(id, holder, lease_until) VALUES (1, 'elsewhere', ${Date.now() + 60_000})`);
  const auditA = await auditFor('audit-a'), auditB = await auditFor('audit-b');
  // Audited writes need a principal-providing mount; the direct activation declares every mount as one.
  const a = await serve(t, database, activation, audited, { audit: auditA.exports }), b = await serve(t, database, activation, audited, { audit: auditB.exports });
  assert.equal((await a.call('POST', '/api/todos', { title: 'one' })).status, 201);
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(outbox(database).length, 1, 'neither process drains while another holds a live lease');
  assert.deepEqual([await delivered(auditA), await delivered(auditB)], [0, 0]);
  // The lease expires: one of the two takes it and delivers the event, once.
  execute(database, `UPDATE store_audit_drain SET lease_until = ${Date.now() - 1}`);
  await until(() => outbox(database).length === 0);
  const counted = [await delivered(auditA), await delivered(auditB)];
  assert.deepEqual(counted.slice().sort(), [0, 1], 'delivered exactly once');
  const [holder, peer, peerAudit] = counted[0] === 1 ? [a, b, auditB] : [b, a, auditA];
  const holderAudit = counted[0] === 1 ? auditA : auditB;
  // The holder closes: its lease is released, and the peer drains the next event without waiting for expiry.
  await holder.close();
  assert.equal((await peer.call('POST', '/api/todos', { title: 'two' })).status, 201);
  await until(() => outbox(database).length === 0, 4000);
  assert.deepEqual([await delivered(peerAudit), await delivered(holderAudit)], [1, 1], 'the second event went to the peer');
});
