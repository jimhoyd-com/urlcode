// A really full filesystem under a real `urlcode serve` process (#902): the site and its data directory (store.sqlite,
// with its audit log, and auth.sqlite) live on a small filesystem of their own, which a filler file then fills to
// ENOSPC. The server keeps running; every write answers a documented refusal or commits whole with its audit events;
// once the filler is removed the same Idempotency-Keys run for the first time, and `PRAGMA integrity_check` is ok on
// both files. `test/disk-full.test.ts` is the deterministic, every-OS version (a capped database).
//
// URLCODE_DISK_FULL_DIR names the filesystem, which must be at most 64 MiB (so this can never fill a real disk). CI
// mounts a tmpfs on Linux: `sudo mount -t tmpfs -o size=16m,mode=1777 tmpfs <dir>`; on macOS a disk image works:
// `hdiutil attach -mountpoint <dir> $(hdiutil create -size 16m -fs HFS+ -volname full -o full.dmg | ...)`.
// Run after `npm run build` and `node scripts/workspaces.ts run build` (npm run test:disk-full).
// Everything here is synthetic: generated secrets, example.test addresses, invented titles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, statfs, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import { repositoryRoot } from '../scripts/workspaces.ts';

const ORIGIN = 'https://disk-full.example.test';
const MAX_FILESYSTEM = 64 * 1024 * 1024;
const cli = join(repositoryRoot, 'dist', 'cli.js');
const authCli = join(repositoryRoot, 'packages', 'auth', 'dist', 'cli.js');
const user = { email: 'filler@example.test', password: 'disk full harness passphrase', name: 'Filler' };

const project = {
  version: '1',
  extensions: {
    auth: { version: '1', config: {} },
    store: { version: '1', config: { collections: {
      notes: { mount: '/api/notes', audit: true, idempotency: { maxKeys: 1000 }, maxRecords: 10000, schema: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 2000 } } } },
      accounts: {
        mount: '/api/accounts', audit: true, idempotency: { maxKeys: 1000 }, defaults: { balance: 0 }, readOnlyProperties: ['balance'],
        schema: { type: 'object', additionalProperties: false, required: ['name', 'balance'], properties: { name: { type: 'string', maxLength: 20 }, balance: { type: 'integer', minimum: -1_000_000 } } },
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
// Sign-in's limit is raised (an operator option) so the sign-in loop below meets the full disk, not the limiter.
const host = [
  "import { composeHost } from '@jimhoyd/urlcode/host';",
  "import auth from '@jimhoyd/urlcode-auth/extension';",
  "import store from '@jimhoyd/urlcode-store/extension';",
  "export default await composeHost(import.meta.url, [auth({ betterAuth: { rateLimit: { customRules: { '/sign-in/email': { window: 60, max: 100000 } } } } }), store()]);",
  '',
].join('\n');

interface Answer { status: number; body: Record<string, unknown> | undefined; replayed: boolean; cookies: number; error?: string }
const code = (answer: Answer): string | undefined => (answer.body?.error as { code?: string } | undefined)?.code ?? (typeof answer.body?.error === 'string' ? answer.body.error : undefined);
const show = (answers: readonly Answer[]): string => JSON.stringify(answers.map(answer => answer.error ?? `${answer.status}${code(answer) ? ` ${code(answer)}` : ''}`));
const unavailable = (answer: Answer): boolean => answer.status === 503 && code(answer) === 'storage_unavailable';
function withDatabase<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=5000'); return work(db); } finally { db.close(); }
}
const count = (path: string, sql: string): number => withDatabase(path, db => Number((db.prepare(sql).get() as { n: number }).n));
/** Writes `file` until the filesystem refuses (ENOSPC), in shrinking chunks down to one byte; the bytes written. */
function fillFilesystem(file: string): number {
  const fd = openSync(file, 'w', 0o600);
  let written = 0;
  try {
    for (let size = 1024 * 1024; size >= 1; size = Math.floor(size / 2)) {
      const chunk = randomBytes(size);
      for (;;) {
        try { written += writeSync(fd, chunk); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOSPC') break; throw error; }
      }
    }
  } finally { closeSync(fd); }
  return written;
}

test('a full filesystem under urlcode serve: documented refusals, nothing partial, recovery and integrity', { timeout: 240_000 }, async t => {
  const target = process.env.URLCODE_DISK_FULL_DIR;
  assert.ok(target, 'Set URLCODE_DISK_FULL_DIR to a small filesystem of its own (a tmpfs of 16 MiB, say); see the comment at the top of this file');
  const space = await statfs(target);
  assert.ok(space.blocks * space.bsize <= MAX_FILESYSTEM, `${target} is ${space.blocks * space.bsize} bytes; this harness fills it, so it must be a filesystem of at most ${MAX_FILESYSTEM} bytes`);

  const root = await realpath(await mkdtemp(join(target, 'urlcode-disk-full-')));
  const held: { server?: { proc: ChildProcess; exited: Promise<void>; stderr: () => string } } = {};
  const filler = join(root, 'filler');
  t.after(async () => {
    const { server } = held;
    if (server && server.proc.exitCode === null && server.proc.signalCode === null) { server.proc.kill('SIGKILL'); await server.exited; }
    if (server?.stderr().trim()) t.diagnostic(`server stderr (tail): ${server.stderr().trim().slice(-2000)}`);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const site = join(root, 'site'), app = join(site, 'app'), data = join(site, 'data');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify(project, null, 2));
  await writeFile(join(site, 'host.mjs'), host);
  await writeFile(join(site, 'package.json'), JSON.stringify({ name: 'disk-full-site', private: true, type: 'module' }));
  await symlink(join(repositoryRoot, 'node_modules'), join(site, 'node_modules'), 'dir');
  const env = { ...process.env, PROJECT_SHA256: await inspectExtensionRevision(app), BETTER_AUTH_SECRET: randomBytes(32).toString('base64url') };
  const files = { store: join(data, 'store.sqlite'), auth: join(data, 'auth.sqlite') };

  for (const [args, input] of [[['migrate'], ''], [['create-user'], JSON.stringify(user)]] as const) {
    const run = spawnSync(process.execPath, [authCli, ...args, '--site', site], { env, input, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
  }
  const proc = spawn(process.execPath, [cli, 'serve', '--project', app, '--host-file', join(site, 'host.mjs'), '--origin', ORIGIN, '--host', '127.0.0.1', '--port', '0', '--json'], { cwd: site, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16384); });
  const exited = new Promise<void>(resolve => { proc.once('exit', () => resolve()); });
  held.server = { proc, exited, stderr: () => stderr };
  const port = await new Promise<number>((resolve, reject) => {
    createInterface({ input: proc.stdout! }).on('line', line => {
      let event: { event?: string; port?: number } = {};
      try { event = JSON.parse(line) as typeof event; } catch { /* a readable line; keep reading */ }
      if (event.event === 'listening') resolve(event.port!);
    });
    void exited.then(() => reject(new Error(`the server exited before listening: ${stderr}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const running = () => proc.exitCode === null && proc.signalCode === null;

  const jar = new Map<string, string>();
  async function call(method: string, path: string, init: { body?: unknown; key?: string; signedIn?: boolean } = {}): Promise<Answer> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers.origin = ORIGIN;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.key) headers['idempotency-key'] = init.key;
    if (init.signedIn !== false && jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    let response: Response;
    try { response = await fetch(base + path, { method, headers, signal: AbortSignal.timeout(20_000), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }); }
    catch (error) { return { status: 0, body: undefined, replayed: false, cookies: 0, error: (error as Error).message }; }
    if (init.signedIn !== false) for (const cookie of response.headers.getSetCookie()) { const [pair = ''] = cookie.split(';'), at = pair.indexOf('='); jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    const text = await response.text();
    let body: Record<string, unknown> | undefined;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = undefined; }
    return { status: response.status, body, replayed: response.headers.get('idempotency-replayed') === 'true', cookies: response.headers.getSetCookie().length };
  }
  const signIn = (signedIn = true) => call('POST', '/api/auth/sign-in/email', { body: { email: user.email, password: user.password }, signedIn });
  assert.equal((await signIn()).status, 200);
  const ids: Record<string, string> = {};
  for (const name of ['bank', 'a', 'b']) ids[name] = (await call('POST', '/api/accounts', { body: { name } })).body!.id as string;
  for (const name of ['a', 'b']) assert.equal((await call('POST', '/api/accounts/transfers/fund', { body: { from: ids.bank, to: ids[name], amount: 100 }, key: `fund-${name}` })).status, 200);
  const title = (index: number): string => `note ${index} `.padEnd(1500, 'x');

  // The disk fills.
  const filled = fillFilesystem(filler);
  t.diagnostic(`filler: ${filled} bytes; filesystem ${space.blocks * space.bsize} bytes`);

  // Creates until the store refuses one. A write may still commit into the space its write-ahead log already holds;
  // every answer is either a committed 201 or the documented 503.
  const creates: Answer[] = [];
  for (let index = 0; index < 4000 && !creates.some(unavailable); index++) creates.push(await call('POST', '/api/notes', { body: { title: title(index) }, key: `note-${index}` }));
  assert.ok(creates.every(answer => answer.status === 201 || unavailable(answer)), show(creates.slice(-5)));
  const refused = creates.findIndex(unavailable);
  assert.ok(refused >= 0, 'the full filesystem refused a create');
  const transfers: Answer[] = [];
  for (let index = 0; index < 4000 && !transfers.some(unavailable); index++) transfers.push(await call('POST', '/api/accounts/transfers/move', { body: { from: ids[index % 2 ? 'a' : 'b'], to: ids[index % 2 ? 'b' : 'a'], amount: 1 }, key: `move-${index}` }));
  assert.ok(transfers.every(answer => answer.status === 200 || unavailable(answer)), show(transfers.slice(-5)));
  const moved = transfers.findIndex(unavailable);
  assert.ok(moved >= 0, 'the full filesystem refused a transfer');
  const signIns: Answer[] = [];
  for (let index = 0; index < 4000 && signIns.every(answer => answer.status === 200); index++) signIns.push(await signIn(false));
  const signInRefusal = signIns.at(-1)!;
  assert.ok(signIns.slice(0, -1).every(answer => answer.cookies > 0), show(signIns.slice(-5)));
  assert.deepEqual([signInRefusal.status, signInRefusal.body, signInRefusal.cookies], [503, { error: 'auth_unavailable' }, 0], show(signIns.slice(-5)));
  // The signed-in session still verifies (a read), and reads still answer.
  assert.equal((await call('GET', '/api/notes')).status, 200);
  assert.ok(running(), 'the server kept running on the full disk');
  t.diagnostic(`full: ${refused} creates, ${moved} transfers and ${signIns.length - 1} sign-ins committed before the first refusal of each`);

  // Nothing partial: rows, claims, balances and audit events are exactly the committed changes.
  const facts = () => ({
    events: count(files.store, "SELECT count(*) AS n FROM store_audit_events WHERE json_extract(metadata, '$.collection') = 'notes'"),
    notes: count(files.store, "SELECT count(*) AS n FROM store_records WHERE collection = 'notes'"),
    noteClaims: count(files.store, "SELECT count(*) AS n FROM store_idempotency WHERE collection = 'notes'"),
    transferClaims: count(files.store, "SELECT count(*) AS n FROM store_idempotency WHERE collection = 'accounts'"),
    sum: count(files.store, "SELECT sum(json_extract(data, '$.balance')) AS n FROM store_records WHERE collection = 'accounts'"),
  });
  assert.deepEqual(facts(), { events: refused, notes: refused, noteClaims: refused, transferClaims: 2 + moved, sum: 0 });

  // Space frees up: the refused keys run for the first time and sign-in works.
  await unlink(filler);
  const retried = await call('POST', '/api/notes', { body: { title: title(refused) }, key: `note-${refused}` });
  assert.deepEqual([retried.status, retried.replayed], [201, false], show([retried]));
  const retriedMove = await call('POST', '/api/accounts/transfers/move', { body: { from: ids[moved % 2 ? 'a' : 'b'], to: ids[moved % 2 ? 'b' : 'a'], amount: 1 }, key: `move-${moved}` });
  assert.deepEqual([retriedMove.status, retriedMove.replayed], [200, false], show([retriedMove]));
  assert.equal((await signIn()).status, 200);
  assert.deepEqual(facts(), { events: refused + 1, notes: refused + 1, noteClaims: refused + 1, transferClaims: 3 + moved, sum: 0 });

  proc.kill('SIGTERM'); await exited;
  for (const file of Object.values(files)) assert.equal(withDatabase(file, db => (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check), 'ok', file);
  const events = (action: string, collection: string) => count(files.store, `SELECT count(*) AS n FROM store_audit_events WHERE action = '${action}' AND json_extract(metadata, '$.collection') = '${collection}'`);
  assert.equal(events('store.record.created', 'notes'), refused + 1);
  assert.equal(events('store.record.created', 'accounts'), 3);
  assert.equal(events('store.record.transferred', 'accounts'), 2 * (3 + moved));
  assert.equal(count(files.store, 'SELECT count(*) - count(DISTINCT id) AS n FROM store_audit_events'), 0, 'no event stored twice');
});
