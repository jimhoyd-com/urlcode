// A full disk, deterministically and on every OS (#902): each SQLite database the extensions own (store.sqlite,
// audit.sqlite, auth.sqlite) is capped at the pages it already has (`PRAGMA max_page_count`, which is per connection,
// so every connection to the file gets it) and its free space is used up by a filler table, so the next write that
// needs a page fails with SQLITE_FULL exactly as it would on a full filesystem. The test then checks what a caller sees
// (a documented refusal, never a false success), that nothing partial was written (a record, its Idempotency-Key claim
// and its audit event together or not at all), that the service recovers once space frees up, and that
// `PRAGMA integrity_check` is ok afterwards. `test/disk-full.integration.ts` fills a real filesystem instead.
// Everything is synthetic: example.test addresses, generated secrets, invented titles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { AuditError, createAudit } from '../packages/audit/src/index.ts';
import { betterAuthOptions, createAuthExtension, migrate } from '../packages/auth/src/index.ts';
import { StoreError, createStore } from '../packages/store/src/index.ts';

const origin = 'https://disk-full.example.test', secret = randomBytes(32).toString('base64url');
const user = { email: 'filler@example.test', password: 'disk full harness passphrase', name: 'Filler' };
const project = {
  version: '1',
  extensions: {
    audit: { version: '1', config: {} },
    auth: { version: '1', config: {} },
    store: { version: '1', config: { collections: {
      notes: { mount: '/api/notes', audit: true, idempotency: { maxKeys: 1000 }, maxRecords: 10000, schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 2000 } } } },
      accounts: {
        mount: '/api/accounts', audit: true, idempotency: { maxKeys: 1000 }, defaults: { balance: 0 }, readOnlyProperties: ['balance'],
        schema: { type: 'object', additionalProperties: false, required: ['name', 'balance'], properties: { name: { type: 'string', maxLength: 20 }, balance: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 } } },
        transfers: { move: { amount: 'balance' }, fund: { amount: 'balance', min: -1_000_000 } },
      },
    } } },
  },
  routes: {
    '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] },
    '/api/notes/*': { extension: 'store', methods: ['GET', 'POST'], auth: true },
    '/api/accounts/*': { extension: 'store', methods: ['GET', 'POST'], auth: true },
  },
};

// Every node:sqlite connection this process opens from here on, so a test can cap each one on a given file: each
// extension opens its own connection and runs `exec` on it first.
const connections = new Set<DatabaseSync>();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function capture(this: DatabaseSync, sql: string) { connections.add(this); return exec.call(this, sql); };
test.after(() => { DatabaseSync.prototype.exec = exec; });

const full = (error: unknown): boolean => error instanceof Error && (error as { errcode?: number }).errcode === 13;
const on = (file: string): DatabaseSync[] => [...connections].filter(db => db.isOpen && (db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).some(row => row.name === 'main' && row.file === file));
/**
 * Fills `file` as a full disk would: every connection to it is capped at the pages the file has now, and a filler table
 * then takes every free byte (the freelist and the new pages up to the cap), down to rows of one byte. `release` gives
 * the space back: the cap is lifted on every connection and the filler dropped.
 */
function fill(file: string): { release(): void } {
  const filler = new DatabaseSync(file);
  filler.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS disk_full_filler(b BLOB)');
  const capped = on(file), before = new Map(capped.map(db => [db, Number((db.prepare('PRAGMA max_page_count').get() as { max_page_count: number }).max_page_count)]));
  const pages = Number((filler.prepare('PRAGMA page_count').get() as { page_count: number }).page_count);
  for (const db of capped) db.exec(`PRAGMA max_page_count=${pages}`);
  const insert = filler.prepare('INSERT INTO disk_full_filler(b) VALUES (?)');
  for (let size = 4096; size >= 1; size = Math.floor(size / 2)) for (;;) {
    try { insert.run(randomBytes(size)); } catch (error) { if (full(error)) break; throw error; }
  }
  return {
    release() {
      for (const [db, pages] of before) if (db.isOpen) db.exec(`PRAGMA max_page_count=${pages}`);
      filler.exec('DROP TABLE disk_full_filler');
      filler.close();
    },
  };
}

interface Answer { status: number; body: Record<string, unknown> | undefined; replayed: boolean; retryAfter: string | null; cookies: number }
const code = (answer: Answer): string | undefined => (answer.body?.error as { code?: string } | undefined)?.code ?? (typeof answer.body?.error === 'string' ? answer.body.error : undefined);
const show = (answers: readonly Answer[]): string => JSON.stringify(answers.map(answer => `${answer.status}${code(answer) ? ` ${code(answer)}` : ''}`));
const unavailable = (answer: Answer): boolean => answer.status === 503 && code(answer) === 'storage_unavailable';
const until = async (what: string, check: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 50)); }
};

test('a full store, audit or auth database answers a documented refusal, writes nothing partial and recovers', { timeout: 120_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'urlcode-disk-full-')));
  const closers: (() => unknown)[] = [];
  t.after(async () => { while (closers.length) await closers.pop()!(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const app = join(root, 'app'), data = join(root, 'data');
  await mkdir(app, { recursive: true }); await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify(project, null, 2));
  const projectSha256 = await inspectExtensionRevision(app);
  const files = { store: join(data, 'store.sqlite'), audit: join(data, 'audit.sqlite'), auth: join(data, 'auth.sqlite') };

  // Better Auth's tables and one account, as `urlcode-auth migrate` and `create-user` make them. Sign-in's limit is
  // raised so the auth phase below fills the database rather than the limiter.
  // Better Auth's own error log of each refused insert is silenced; the answers are asserted instead.
  const betterAuthExtra = { rateLimit: { customRules: { '/sign-in/email': { window: 60, max: 100_000 } } }, logger: { disabled: true } };
  const setup = betterAuthOptions({ database: files.auth, secret, betterAuth: betterAuthExtra }, origin, '/api/auth', true);
  try { await migrate(setup); await betterAuth(setup).api.signUpEmail({ body: user }); } finally { (setup.database as DatabaseSync).close(); }

  const audit = await createAudit({ database: files.audit, projectSha256 });
  closers.push(() => audit.close());
  const store = createStore({ database: files.store, projectSha256, audit: audit.exports });
  const auth = createAuthExtension({ projectSha256, database: files.auth, secret, betterAuth: betterAuthExtra });
  const server = await startServer({ project: app, origin, port: 0, log: () => {}, extensions: [audit.registration, auth, store.registration] });
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;

  const jar = new Map<string, string>();
  async function call(method: string, path: string, init: { body?: unknown; key?: string; signedIn?: boolean } = {}): Promise<Answer> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers.origin = origin;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.key) headers['idempotency-key'] = init.key;
    if (init.signedIn !== false && jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(base + path, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    if (init.signedIn !== false) for (const cookie of response.headers.getSetCookie()) { const [pair = ''] = cookie.split(';'), at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    const text = await response.text();
    let body: Record<string, unknown> | undefined;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = undefined; }
    return { status: response.status, body, replayed: response.headers.get('idempotency-replayed') === 'true', retryAfter: response.headers.get('retry-after'), cookies: response.headers.getSetCookie().length };
  }
  const signIn = (signedIn = true) => call('POST', '/api/auth/sign-in/email', { body: { email: user.email, password: user.password }, signedIn });
  assert.equal((await signIn()).status, 200);

  // The checker's own connection reads committed state; it is never capped (it opens after nothing but reads).
  const read = <T>(file: string, sql: string): T => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).get() as T; } finally { db.close(); } };
  const count = (file: string, sql: string): number => Number(read<{ n: number }>(file, sql).n);

  const ids: Record<string, string> = {};
  for (const name of ['bank', 'a', 'b']) ids[name] = (await call('POST', '/api/accounts', { body: { name } })).body!.id as string;
  for (const name of ['a', 'b']) assert.equal((await call('POST', '/api/accounts/transfers/fund', { body: { from: ids.bank, to: ids[name], amount: 100 }, key: `fund-${name}` })).status, 200);
  const balances = () => count(files.store, "SELECT sum(json_extract(data, '$.balance')) AS n FROM store_records WHERE collection = 'accounts'");

  // Each committed change is counted here; at the end audit.sqlite must hold exactly one event per change.
  const committed = { notes: 0, transfers: 2 };
  const title = (index: number): string => `note ${index} `.padEnd(1500, 'x');

  await t.test('store.sqlite full: 503 storage_unavailable, all or nothing, then recovery', async () => {
    const space = fill(files.store);
    // Creates until the store refuses one: every answer is a 201 that committed or the documented 503.
    const creates: Answer[] = [];
    for (let index = 0; index < 200 && !creates.some(unavailable); index++) creates.push(await call('POST', '/api/notes', { body: { title: title(index) }, key: `note-${index}` }));
    assert.ok(creates.every(answer => answer.status === 201 || unavailable(answer)), show(creates));
    const refused = creates.findIndex(unavailable);
    assert.ok(refused >= 0, `the full database refused a create: ${show(creates)}`);
    assert.deepEqual(creates[refused]!.body, { error: { code: 'storage_unavailable', message: 'The store could not save this change' } });
    committed.notes += refused;
    // Transfers until one is refused: each moves both balances, claims its key and queues two audit events, or none of it.
    const transfers: Answer[] = [];
    for (let index = 0; index < 200 && !transfers.some(unavailable); index++) transfers.push(await call('POST', '/api/accounts/transfers/move', { body: { from: ids[index % 2 ? 'a' : 'b'], to: ids[index % 2 ? 'b' : 'a'], amount: 1 }, key: `move-${index}` }));
    assert.ok(transfers.every(answer => answer.status === 200 || unavailable(answer)), show(transfers));
    const moved = transfers.findIndex(unavailable);
    assert.ok(moved >= 0, `the full database refused a transfer: ${show(transfers)}`);
    committed.transfers += moved;
    // A host transaction of two creates, retry-safe with a key: refused whole.
    const twoNotes = () => store.exports.transaction(tx => { tx.records('notes').create({ id: 'operator' }, { title: title(1000) }); tx.records('notes').create({ id: 'operator' }, { title: title(1001) }); return 'both'; }, { idempotencyKey: 'host-two-notes' });
    assert.throws(twoNotes, (error: unknown) => error instanceof StoreError && error.status === 503 && error.code === 'storage_unavailable');
    // Reads keep working on a full disk.
    assert.equal((await call('GET', '/api/notes')).status, 200);

    // Nothing partial: the rows, the claims and the queued or delivered events are exactly the committed changes.
    const facts = () => ({
      notes: count(files.store, "SELECT count(*) AS n FROM store_records WHERE collection = 'notes'"),
      noteClaims: count(files.store, "SELECT count(*) AS n FROM store_idempotency WHERE collection = 'notes'"),
      transferClaims: count(files.store, "SELECT count(*) AS n FROM store_idempotency WHERE collection = 'accounts'"),
      hostClaims: count(files.store, 'SELECT count(*) AS n FROM store_transaction_results'),
      sum: balances(),
    });
    assert.deepEqual(facts(), { notes: committed.notes, noteClaims: committed.notes, transferClaims: committed.transfers, hostClaims: 0, sum: 0 });

    space.release();
    // The refused create and transfer, retried with their keys, now run for the first time (not replays).
    const retried = await call('POST', '/api/notes', { body: { title: title(refused) }, key: `note-${refused}` });
    assert.equal(retried.status, 201); assert.equal(retried.replayed, false);
    const retriedMove = await call('POST', '/api/accounts/transfers/move', { body: { from: ids[moved % 2 ? 'a' : 'b'], to: ids[moved % 2 ? 'b' : 'a'], amount: 1 }, key: `move-${moved}` });
    assert.equal(retriedMove.status, 200); assert.equal(retriedMove.replayed, false);
    assert.equal(twoNotes(), 'both');
    committed.notes += 3; committed.transfers += 1;
    assert.deepEqual(facts(), { notes: committed.notes, noteClaims: committed.notes - 2, transferClaims: committed.transfers, hostClaims: 1, sum: 0 });
    t.diagnostic(`store full after ${refused} creates and ${moved} transfers; recovered`);
  });

  await t.test('audit.sqlite full: record() answers 503 audit_unavailable, store events wait in the outbox, then drain once', async () => {
    const outbox = () => count(files.store, 'SELECT count(*) AS n FROM store_audit_outbox');
    await until('the outbox to drain', () => outbox() === 0, 20_000);
    const logged = () => count(files.audit, 'SELECT count(*) AS n FROM audit_events');
    const space = fill(files.audit);
    // A direct record() of a batch is refused whole: no event of it is stored.
    const event = (index: number) => ({ id: randomUUID(), source: 'diskfull', action: 'diskfull.recorded', actor: 'operator', subject: `batch-${index}`, at: Date.now() });
    const before = logged();
    await assert.rejects(audit.exports.record(Array.from({ length: 50 }, (_, index) => event(index))), (error: unknown) => error instanceof AuditError && error.status === 503 && error.code === 'audit_unavailable');
    assert.equal(logged(), before, 'a refused batch stores none of its events');
    // Store writes on an audited collection still commit: their events wait in the store's outbox for the drain.
    const writes: Answer[] = [];
    for (let index = 0; index < 40; index++) writes.push(await call('POST', '/api/notes', { body: { title: `audited while full ${index}` } }));
    assert.ok(writes.every(answer => answer.status === 201), show(writes));
    committed.notes += writes.length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.ok(outbox() > 0, 'the drain could not store the events, so they stay queued');
    assert.equal(logged() + outbox(), before + writes.length, 'every event is queued or stored, none twice');
    space.release();
    await until('the drain to deliver the queued events', () => outbox() === 0, 20_000);
    assert.equal(logged(), before + writes.length);
  });

  await t.test('auth.sqlite full: sign-in answers 503 auth_unavailable and stores no session, a signed-in route is never a false 401, then recovery', async () => {
    const sessions = () => count(files.auth, 'SELECT count(*) AS n FROM session');
    const space = fill(files.auth);
    // Sign-ins until one is refused: each stores a session and sets its cookie, or answers the documented 503 and
    // stores and sets nothing. Better Auth's own answer to the failed insert is a 500; the mount answers 503.
    const attempts: Answer[] = [];
    for (let index = 0; index < 200 && attempts.every(answer => answer.status === 200); index++) attempts.push(await signIn(false));
    const refusal = attempts.at(-1)!;
    assert.ok(attempts.slice(0, -1).every(answer => answer.status === 200 && answer.cookies > 0), show(attempts));
    assert.deepEqual([refusal.status, refusal.body, refusal.retryAfter, refusal.cookies], [503, { error: 'auth_unavailable' }, '1', 0], show(attempts));
    const stored = sessions();
    const again = await signIn(false);
    assert.deepEqual([again.status, again.cookies], [503, 0]);
    assert.equal(sessions(), stored, 'a refused sign-in stores no session');
    // The signed-in session is still verified (a read), so a protected route answers 200, never 401.
    assert.equal((await call('GET', '/api/notes')).status, 200);
    space.release();
    assert.equal((await signIn()).status, 200);
    assert.equal((await call('GET', '/api/notes')).status, 200);
    t.diagnostic(`auth full after ${attempts.length - 1} sign-ins; recovered`);
  });

  await t.test('afterwards: integrity_check is ok on every file and each committed change was audited once', async () => {
    await until('the outbox to drain', () => count(files.store, 'SELECT count(*) AS n FROM store_audit_outbox') === 0, 20_000);
    while (closers.length) await closers.pop()!();
    for (const file of Object.values(files)) assert.equal(read<{ integrity_check: string }>(file, 'PRAGMA integrity_check').integrity_check, 'ok', file);
    assert.equal(balances(), 0);
    const events = (action: string, collection: string) => count(files.audit, `SELECT count(*) AS n FROM audit_events WHERE action = '${action}' AND json_extract(metadata, '$.collection') = '${collection}'`);
    assert.equal(events('store.record.created', 'notes'), committed.notes);
    assert.equal(events('store.record.created', 'accounts'), 3);
    assert.equal(events('store.record.transferred', 'accounts'), 2 * committed.transfers);
    assert.equal(count(files.audit, 'SELECT count(*) - count(DISTINCT id) AS n FROM audit_events'), 0, 'no event stored twice');
  });
});
