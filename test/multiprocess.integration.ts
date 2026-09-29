// Several `urlcode serve` processes on one host sharing one site's data directory (#927), end to end: three real
// server processes (the built CLI, the site's own host.mjs composing audit, auth and store from this checkout) on
// distinct ports, one store.sqlite, one auth.sqlite and one audit.sqlite. It races the store's invariants across the
// processes over HTTP (Idempotency-Key, a transition, transfers, intervals), checks that the one audit drainer delivers
// each event exactly once, bursts sign-ins and signed-in reads across the processes (never a false 401), then SIGKILLs
// the process holding the audit drain lease mid-load and checks integrity and every invariant afterwards.
// Run after `npm run build` and `node scripts/workspaces.ts run build` (npm run test:multiprocess). CI runs it on Linux;
// it is bounded (about a minute) and asserts only what the contract guarantees whatever the scheduling was.
// Everything here is synthetic: generated secrets, example.test addresses, invented account names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import { repositoryRoot } from '../scripts/workspaces.ts';

const ORIGIN = 'https://site.example';
const SERVERS = 3;
const cli = join(repositoryRoot, 'dist', 'cli.js');
const authCli = join(repositoryRoot, 'packages', 'auth', 'dist', 'cli.js');
const user = { email: 'operator@example.test', password: 'multiprocess harness passphrase', name: 'Operator' };

const slots = { type: 'object', additionalProperties: false, required: ['room', 'start', 'end'], properties: { room: { type: 'string', maxLength: 20 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } } };
const project = {
  version: '1',
  extensions: {
    audit: { version: '1', config: {} },
    auth: { version: '1', config: {} },
    store: { version: '1', config: { collections: {
      // Shared accounts: each opens at 0 and only a transfer changes a balance; fund lets the bank go negative, so the
      // sum over the collection is 0 after every commit. Every transfer carries an Idempotency-Key, so the retained
      // claims count the committed transfers (maxKeys 1000 is above the harness's total).
      accounts: {
        mount: '/api/accounts', audit: true, idempotency: { maxKeys: 1000 }, defaults: { balance: 0 }, readOnlyProperties: ['balance'],
        schema: { type: 'object', additionalProperties: false, required: ['name', 'balance'], properties: { name: { type: 'string', maxLength: 20 }, balance: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 } } },
        transfers: { move: { amount: 'balance' }, fund: { amount: 'balance', min: -1_000_000 } },
      },
      tickets: {
        mount: '/api/tickets', audit: true, idempotency: { maxKeys: 1000 }, defaults: { status: 'open' }, readOnlyProperties: ['status'],
        schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 40 }, status: { type: 'string', enum: ['open', 'claimed'] } } },
        transitions: { claim: { from: { status: 'open' }, set: { status: 'claimed' } } },
      },
      rooms: { mount: '/api/rooms', audit: true, schema: slots, intervals: { start: 'start', end: 'end', within: ['room'] } },
    } } },
  },
  routes: {
    '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] },
    '/api/accounts/*': { extension: 'store', methods: ['GET', 'POST'], auth: true },
    '/api/tickets/*': { extension: 'store', methods: ['GET', 'POST'], auth: true },
    '/api/rooms/*': { extension: 'store', methods: ['GET', 'POST'], auth: true },
  },
};
const host = [
  "import { composeHost } from '@jimhoyd/urlcode/host';",
  "import audit from '@jimhoyd/urlcode-audit/extension';",
  "import auth from '@jimhoyd/urlcode-auth/extension';",
  "import store from '@jimhoyd/urlcode-store/extension';",
  'export default await composeHost(import.meta.url, [audit(), auth(), store()]);',
  '',
].join('\n');

interface Answer { status: number; body: Record<string, unknown> | undefined; replayed: boolean; error?: string }
interface Server { index: number; base: string; pid: number; proc: ChildProcess; exited: Promise<void>; stderr: () => string }
type Jar = Map<string, string>;

function withDatabase<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=5000'); return work(db); } finally { db.close(); }
}
const code = (answer: Answer): string | undefined => (answer.body?.error as { code?: string } | undefined)?.code;
const statuses = (answers: readonly Answer[]): string => JSON.stringify(answers.map(answer => answer.error ?? `${answer.status}${code(answer) ? ` ${code(answer)}` : ''}`));
/** A write that waited past the busy timeout: refused, and nothing was written. */
const busy = (answer: Answer): boolean => answer.status === 503 && code(answer) === 'storage_unavailable';

/** One request as a same-origin browser on ORIGIN would send it; a network failure is status 0, never a throw. */
async function call(base: string, method: string, path: string, init: { body?: unknown; key?: string; jar?: Jar } = {}): Promise<Answer> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers.origin = ORIGIN;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.key) headers['idempotency-key'] = init.key;
  if (init.jar?.size) headers.cookie = [...init.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  let response: Response;
  try { response = await fetch(base + path, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(20_000), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }); }
  catch (error) { return { status: 0, body: undefined, replayed: false, error: (error as Error).cause ? String((error as { cause: { code?: string } }).cause.code ?? (error as Error).message) : (error as Error).message }; }
  if (init.jar) for (const cookie of response.headers.getSetCookie()) {
    const [pair = ''] = cookie.split(';'), at = pair.indexOf('=');
    if (/max-age=0/i.test(cookie)) init.jar.delete(pair.slice(0, at)); else init.jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await response.text();
  let body: Record<string, unknown> | undefined;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = undefined; }
  return { status: response.status, body, replayed: response.headers.get('idempotency-replayed') === 'true' };
}
/** Runs `jobs` with at most `width` in flight, in order of start; answers in job order. */
async function pool<T>(jobs: readonly (() => Promise<T>)[], width: number): Promise<T[]> {
  const results: T[] = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => { while (next < jobs.length) { const at = next++; results[at] = await jobs[at]!(); } }));
  return results;
}
const until = async (what: string, check: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 100)); }
};

test('three serving processes on one data directory keep every store, audit and auth guarantee, through a SIGKILL', { timeout: 240_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-multiprocess-'));
  const servers: Server[] = [];
  let stopSampling = async (): Promise<void> => {};
  // One unwind stack: stop the lease sampler and every child before the directory goes (Windows cannot remove an open
  // database). A child's stderr is reported, so a failure in CI shows what the servers said.
  t.after(async () => {
    await stopSampling();
    for (const server of servers) if (server.stderr().trim()) t.diagnostic(`server ${server.index} stderr: ${server.stderr().trim()}`);
    for (const server of servers) if (server.proc.exitCode === null && server.proc.signalCode === null) { server.proc.kill('SIGKILL'); await server.exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const site = join(root, 'site'), app = join(site, 'app'), data = join(site, 'data');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify(project, null, 2));
  await writeFile(join(site, 'host.mjs'), host);
  await writeFile(join(site, 'package.json'), JSON.stringify({ name: 'multiprocess-site', private: true, type: 'module' }));
  // The site resolves core and the add-ons from this checkout's workspace links, as `npm install` of the packed ones would.
  await symlink(join(repositoryRoot, 'node_modules'), join(site, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env, PROJECT_SHA256: await inspectExtensionRevision(app), BETTER_AUTH_SECRET: randomBytes(32).toString('base64url') };
  const store = join(data, 'store.sqlite'), auth = join(data, 'auth.sqlite'), audit = join(data, 'audit.sqlite');

  // The operator steps: Better Auth's tables, then one account.
  for (const [args, input] of [[['migrate'], ''], [['create-user'], JSON.stringify(user)]] as const) {
    const run = spawnSync(process.execPath, [authCli, ...args, '--site', site], { env, input, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
  }

  const start = async (index: number): Promise<Server> => {
    const proc = spawn(process.execPath, [cli, 'serve', '--project', app, '--host-file', join(site, 'host.mjs'), '--origin', ORIGIN, '--host', '127.0.0.1', '--port', '0', '--json'], { cwd: site, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    const exited = new Promise<void>(resolve => { proc.once('exit', () => resolve()); });
    const lines = createInterface({ input: proc.stdout! });
    const port = await new Promise<number>((resolve, reject) => {
      lines.on('line', line => {
        let event: { event?: string; port?: number } = {};
        try { event = JSON.parse(line) as typeof event; } catch { /* a readable line; keep reading */ }
        if (event.event === 'listening') resolve(event.port!);
      });
      void exited.then(() => reject(new Error(`server ${index} exited before listening: ${stderr}`)));
    });
    const server = { index, base: `http://127.0.0.1:${port}`, pid: proc.pid!, proc, exited, stderr: () => stderr };
    servers.push(server);
    return server;
  };
  // Started one after another: each activation migrates or joins the same files.
  for (let index = 0; index < SERVERS; index++) await start(index);
  const alive = () => servers.filter(server => server.proc.exitCode === null && server.proc.signalCode === null);
  t.diagnostic(`servers: ${servers.map(server => `${server.base} pid ${server.pid}`).join(', ')}`);

  // The audit drain lease is sampled throughout: one holder at a time, and it is always a live serving process.
  const holders: string[] = [];
  const sample = () => withDatabase(store, db => db.prepare('SELECT d.holder AS holder, s.pid AS pid FROM store_audit_drain d LEFT JOIN store_servers s ON s.instance = d.holder WHERE d.id = 1 AND d.lease_until > ?').get(Date.now()) as { holder: string | null; pid: number | null } | undefined);
  let sampling = true;
  const sampler = (async () => { while (sampling) { const lease = sample(); if (lease?.holder && holders.at(-1) !== lease.holder) holders.push(lease.holder); await new Promise(resolve => setTimeout(resolve, 100)); } })();
  stopSampling = async () => { sampling = false; await sampler; };

  // One sign-in; the session cookie is then honoured by every process (one auth.sqlite).
  const jar: Jar = new Map();
  assert.equal((await call(servers[0]!.base, 'POST', '/api/auth/sign-in/email', { body: { email: user.email, password: user.password }, jar })).status, 200);
  for (const server of servers) assert.equal((await call(server.base, 'GET', '/api/accounts', { jar })).status, 200, `server ${server.index} honours the session`);
  const on = (server: Server) => (method: string, path: string, init: { body?: unknown; key?: string } = {}) => call(server.base, method, path, { ...init, jar });
  const at = (index: number) => on(servers[index % SERVERS]!);

  // Accounts, created round robin across the processes and funded from the bank.
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const ids: Record<string, string> = {};
  for (const [index, name] of ['bank', ...names].entries()) {
    const created = await at(index)('POST', '/api/accounts', { body: { name } });
    assert.equal(created.status, 201, statuses([created]));
    ids[name] = created.body!.id as string;
  }
  for (const [index, name] of names.entries()) assert.equal((await at(index)('POST', '/api/accounts/transfers/fund', { body: { from: ids.bank, to: ids[name], amount: 100 }, key: `fund-${name}` })).status, 200);

  const accounts = () => withDatabase(store, db => db.prepare("SELECT id, json_extract(data, '$.balance') AS balance FROM store_records WHERE collection = 'accounts'").all() as { id: string; balance: number }[]);
  const checkAccounts = (): void => {
    const rows = accounts();
    assert.equal(rows.reduce((sum, row) => sum + row.balance, 0), 0, 'the sum over the accounts never changes');
    assert.equal(rows.find(row => row.id === ids.bank)!.balance, -600, 'only fund moves the bank');
    assert.ok(rows.filter(row => row.id !== ids.bank).every(row => row.balance >= 0), 'no account below its floor');
  };
  const checkRooms = (): void => {
    const booked = withDatabase(store, db => db.prepare("SELECT json_extract(data, '$.room') AS room, json_extract(data, '$.start') AS start, json_extract(data, '$.end') AS end FROM store_records WHERE collection = 'rooms' ORDER BY room, start").all() as { room: string; start: number; end: number }[]);
    for (let index = 1; index < booked.length; index++) if (booked[index]!.room === booked[index - 1]!.room) assert.ok(booked[index - 1]!.end <= booked[index]!.start, `bookings in ${booked[index]!.room} overlap`);
  };
  /** Every committed write left exactly one audit event per record it changed, delivered once, and the outbox is empty. */
  const checkAudit = (): { events: number } => {
    const facts = withDatabase(store, db => ({
      outbox: Number(db.prepare('SELECT count(*) AS n FROM store_audit_outbox').get()!.n),
      transfers: Number(db.prepare("SELECT count(*) AS n FROM store_idempotency WHERE collection = 'accounts'").get()!.n),
      records: Object.fromEntries((db.prepare('SELECT collection, count(*) AS n FROM store_records GROUP BY collection').all() as { collection: string; n: number }[]).map(row => [row.collection, Number(row.n)])),
      claimed: Number(db.prepare("SELECT count(*) AS n FROM store_records WHERE collection = 'tickets' AND json_extract(data, '$.status') = 'claimed'").get()!.n),
    }));
    const delivered = withDatabase(audit, db => ({
      total: Number(db.prepare('SELECT count(*) AS n FROM audit_events').get()!.n),
      distinct: Number(db.prepare('SELECT count(DISTINCT id) AS n FROM audit_events').get()!.n),
      byAction: Object.fromEntries((db.prepare("SELECT action || ' ' || json_extract(metadata, '$.collection') AS kind, count(*) AS n FROM audit_events GROUP BY kind").all() as { kind: string; n: number }[]).map(row => [row.kind, Number(row.n)])),
      sides: db.prepare("SELECT json_extract(metadata, '$.side') AS side, count(*) AS n FROM audit_events WHERE action = 'store.record.transferred' GROUP BY side").all().map(row => [row.side, Number(row.n)]),
      // An event's `at` is read while its transaction holds the write lock, so commit order is `at` order on one host's
      // clock; the drainer delivers oldest first, so stored order must never go back in time.
      backwards: Number(db.prepare('SELECT count(*) AS n FROM (SELECT at, lag(at) OVER (ORDER BY seq) AS before FROM audit_events) WHERE at < before').get()!.n),
    }));
    assert.equal(facts.outbox, 0, 'the outbox drained');
    assert.equal(delivered.distinct, delivered.total, 'no event stored twice');
    assert.ok(facts.transfers < 1000, 'every transfer claim is still retained, so the claims count the committed transfers');
    assert.deepEqual(delivered.byAction, {
      'store.record.created accounts': facts.records.accounts,
      'store.record.created tickets': facts.records.tickets,
      'store.record.created rooms': facts.records.rooms,
      'store.record.transferred accounts': 2 * facts.transfers,
      ...(facts.claimed ? { 'store.record.transitioned tickets': facts.claimed } : {}),
    }, 'one event per committed change: none lost, none duplicated');
    assert.deepEqual(delivered.sides, [['from', facts.transfers], ['to', facts.transfers]]);
    assert.equal(delivered.backwards, 0, 'events are stored in commit order, across the lease take-over too');
    return { events: delivered.total };
  };
  const outboxEmpty = () => withDatabase(store, db => Number(db.prepare('SELECT count(*) AS n FROM store_audit_outbox').get()!.n) === 0);

  await t.test('the store race suites across processes', async () => {
    // Transfers: 240 interleaved moves among six accounts, 80 per process, 8 in flight in each.
    const plan = Array.from({ length: 240 }, (_, index) => ({ from: ids[names[index % 6]!]!, to: ids[names[(index + 1 + index % 4) % 6]!]!, amount: 1 + (index * 37) % 60 }));
    const transfers = Promise.all(servers.map(server => pool(plan.filter((_, index) => index % SERVERS === server.index).map((body, index) => () => on(server)('POST', '/api/accounts/transfers/move', { body, key: `move-${server.index}-${index}` })), 8))).then(all => all.flat());
    // Idempotency: one key, one body, four times from each process at once: exactly one create runs.
    const retries = Promise.all(Array.from({ length: 12 }, (_, index) => at(index)('POST', '/api/tickets', { body: { title: 'retried' }, key: 'one-ticket' })));
    // Intervals: overlapping bookings of one room from every process at once.
    const bookings = Promise.all(Array.from({ length: 24 }, (_, index) => at(index)('POST', '/api/rooms', { body: { room: 'hot', start: 10 * Math.floor(index / SERVERS) + index % SERVERS, end: 10 * Math.floor(index / SERVERS) + index % SERVERS + 15 } })));
    // Transitions: twelve claims of one open ticket, four from each process at once.
    const ticket = await at(0)('POST', '/api/tickets', { body: { title: 'contested' } });
    assert.equal(ticket.status, 201);
    const claims = Promise.all(Array.from({ length: 12 }, (_, index) => at(index)('POST', `/api/tickets/${ticket.body!.id as string}/claim`)));

    const moved = await transfers;
    assert.ok(moved.every(answer => answer.status === 200 || code(answer) === 'insufficient_balance' || busy(answer)), statuses(moved));
    assert.ok(moved.some(answer => answer.status === 200));
    checkAccounts();

    const retried = await retries;
    assert.ok(retried.every(answer => answer.status === 201 || busy(answer)), statuses(retried));
    assert.equal(retried.filter(answer => answer.status === 201 && !answer.replayed).length, 1, 'exactly one request ran the create; the others replayed it');
    assert.equal(new Set(retried.filter(answer => answer.status === 201).map(answer => answer.body!.id)).size, 1, 'every replay names the one record');

    const booked = await bookings;
    assert.ok(booked.every(answer => answer.status === 201 || code(answer) === 'interval_conflict' || busy(answer)), statuses(booked));
    assert.ok(booked.some(answer => answer.status === 201) && booked.some(answer => code(answer) === 'interval_conflict'));
    checkRooms();

    const claimed = await claims;
    assert.ok(claimed.every(answer => answer.status === 200 || code(answer) === 'transition_conflict' || busy(answer)), statuses(claimed));
    assert.equal(claimed.filter(answer => answer.status === 200).length, 1, 'exactly one claim wins');

    const counted = withDatabase(store, db => ({
      retried: Number(db.prepare("SELECT count(*) AS n FROM store_records WHERE collection = 'tickets' AND json_extract(data, '$.title') = 'retried'").get()!.n),
      rooms: Number(db.prepare("SELECT count(*) AS n FROM store_records WHERE collection = 'rooms'").get()!.n),
    }));
    assert.deepEqual(counted, { retried: 1, rooms: booked.filter(answer => answer.status === 201).length });
    t.diagnostic(`transfers ${moved.filter(answer => answer.status === 200).length}/240 committed, ${moved.filter(busy).length} busy; bookings ${counted.rooms}/24 committed`);
  });

  await t.test('one drainer delivers every audit event exactly once', async () => {
    await until('the outbox to drain', outboxEmpty, 15_000);
    const { events } = checkAudit();
    assert.equal(holders.length, 1, `one process held the drain lease throughout: ${JSON.stringify(holders)}`);
    t.diagnostic(`${events} audit events delivered by one holder`);
  });

  await t.test('a sign-in burst across processes gives no false 401 and one shared limit', async () => {
    // Twenty-four correct sign-ins, eight per process, while signed-in reads hit every process. The limiter
    // (10 per client address a minute, counted in auth.sqlite) has already counted the one sign-in above.
    const signIns = Promise.all(Array.from({ length: 24 }, (_, index) => call(servers[index % SERVERS]!.base, 'POST', '/api/auth/sign-in/email', { body: { email: user.email, password: user.password } })));
    const reads = Promise.all(Array.from({ length: 60 }, (_, index) => at(index)('GET', '/api/accounts')));
    const [signed, read] = await Promise.all([signIns, reads]);
    assert.ok(signed.every(answer => [200, 429, 503].includes(answer.status)), statuses(signed));
    assert.ok(read.every(answer => [200, 503].includes(answer.status)), statuses(read));
    assert.ok(signed.filter(answer => answer.status === 200).length <= 9, `the limit is one budget across the processes: ${statuses(signed)}`);
    assert.ok(signed.some(answer => answer.status === 429), statuses(signed));
    t.diagnostic(`sign-ins ${statuses(signed)}; reads ${read.filter(answer => answer.status === 200).length}/60 200`);
  });

  await t.test('SIGKILL of the drain holder mid-load: integrity, invariants and exactly-once delivery hold', async () => {
    const lease = sample();
    const victim = servers.find(server => server.pid === lease?.pid);
    assert.ok(victim, 'the drain lease belongs to one of the serving processes');
    // Eight lanes per process write continuously until the kill has settled; at most 900 requests in all, so every
    // transfer claim stays retained (maxKeys 1000). A lane whose process is gone stops at its first unanswered request.
    let loading = true, sent = 0;
    const load = Promise.all(servers.map(server => pool(Array.from({ length: 8 }, () => async () => {
      const answers: Answer[] = [];
      while (loading && sent < 900) {
        const index = sent++, send = on(server);
        // Killed by the lane that sends the 300th request, so every lane is still writing when it dies.
        if (index === 300) victim.proc.kill('SIGKILL');
        const answer = await (index % 3 === 0
          ? send('POST', '/api/rooms', { body: { room: `r${index % 5}`, start: (index * 7) % 200, end: (index * 7) % 200 + 9 } })
          : index % 3 === 1
            ? send('POST', '/api/accounts/transfers/move', { body: { from: ids[names[index % 6]!]!, to: ids[names[(index + 2) % 6]!]!, amount: 1 + index % 25 }, key: `kill-${index}` })
            : send('POST', '/api/tickets', { body: { title: `t${index}` } }));
        answers.push(answer);
        if (answer.status === 0) break;
      }
      return answers;
    }), 8))).then(all => all.flat(2));
    await victim.exited;
    await new Promise(resolve => setTimeout(resolve, 700));
    loading = false;
    const answers = await load;
    // A request to the killed process has no known outcome (status 0); every answer that arrived is a contract answer.
    assert.ok(answers.every(answer => answer.status === 0 || [201, 200].includes(answer.status) || ['insufficient_balance', 'interval_conflict'].includes(code(answer) ?? '') || busy(answer)), statuses(answers));
    assert.ok(answers.some(answer => answer.status === 0), 'requests to the killed process went unanswered');
    t.diagnostic(`${answers.length} requests during the kill: ${answers.filter(answer => answer.status === 0).length} without an answer`);

    // A survivor takes the drain lease over once it expires, and a replacement process starts beside the stale lease row.
    const survivors = alive();
    assert.equal(survivors.length, SERVERS - 1);
    const replacement = await start(SERVERS);
    assert.equal((await on(replacement)('POST', '/api/tickets', { body: { title: 'after the kill' } })).status, 201);
    await until('a survivor to take the drain over and empty the outbox', outboxEmpty, 30_000);
    const next = sample();
    assert.ok(next?.pid && next.pid !== victim.pid && alive().some(server => server.pid === next.pid), 'a live process holds the drain lease');
    assert.ok(holders.every(holder => holder === lease!.holder || holder === next.holder), `the lease changed hands once: ${JSON.stringify(holders)}`);

    // Stop the rest the way a supervisor does, then check the files.
    for (const server of alive()) { server.proc.kill('SIGTERM'); await server.exited; }
    for (const file of [store, auth, audit]) assert.equal(withDatabase(file, db => (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check), 'ok', file);
    checkAccounts();
    checkRooms();
    const { events } = checkAudit();
    t.diagnostic(`after the kill: integrity ok, ${events} audit events, each once`);
  });
});
