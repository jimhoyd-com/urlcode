// The counter table: <site>/data/abuse.sqlite on the main thread. Every statement is indexed and bounded; every
// operation that may add a row first sweeps up to 1000 expired rows and then refuses past maxKeys, or past its
// scope's equal share of maxKeys, so one consumer's attacker-keyed growth cannot lock out the others. synchronous=NORMAL
// can lose the last increments on power loss: the counters are protective, not a record.
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
import { AbuseError } from './types.ts';
import type { AbuseAdmission } from './types.ts';
import type { NormalBackoff } from './budget.ts';
import { backoffDelay } from './budget.ts';

/** SQLite releases carrying the fixes auth also requires. */
export function patched(version: string): boolean { const [a = 0, b = 0, c = 0] = version.split('.').map(Number); return a > 3 || a === 3 && (b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6); }

/** `scope` is `<namespace>/<scope>`: the plain names a consumer chose, never a counted value. */
export interface CounterItem { key: string; scope: string; limit: number; windowMs: number; challengeAfter?: number | undefined }
/** `maxKeys` bounds the table; `share` bounds the rows one scope may hold. */
export interface CounterBounds { maxKeys: number; share: number }
export interface CounterStore {
  admit(items: readonly CounterItem[], now: number, bounds: CounterBounds): AbuseAdmission;
  check(key: string, now: number): { blocked: boolean; retryAfterSeconds: number };
  failure(key: string, scope: string, spec: NormalBackoff, now: number, bounds: CounterBounds): void;
  clear(key: string): void;
  readonly closed: boolean;
  close(): void;
}

/** Creates the file 0600 when absent, then refuses anything that is not a private regular file with one link. */
async function privateFile(path: string): Promise<string> {
  const requested = resolve(path), database = join(await realpath(dirname(requested)), basename(requested));
  try { await (await open(database, 'wx', 0o600)).close(); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const info = await lstat(database);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new Error(`Abuse database ${database} must be a private regular file (mode 0600, one link)`);
  return database;
}

export async function openCounterStore(path: string): Promise<CounterStore> {
  if (!isMainThread) throw new Error('The abuse counter store opens on the main thread');
  if (!patched(process.versions.sqlite || '')) throw new Error(`Abuse requires a patched SQLite (3.44.6, 3.50.7, 3.51.3 or later); this Node has ${process.versions.sqlite ?? 'none'}`);
  const db = new DatabaseSync(await privateFile(path), { allowExtension: false });
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    db.exec('CREATE TABLE IF NOT EXISTS abuse_counters(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL, blocked_until INTEGER NOT NULL, scope TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX IF NOT EXISTS abuse_expires ON abuse_counters(expires); CREATE INDEX IF NOT EXISTS abuse_scope ON abuse_counters(scope);');
  }
  catch (error) { db.close(); throw error; }
  const statement = (sql: string) => db.prepare(sql);
  const select = statement('SELECT count, expires, blocked_until FROM abuse_counters WHERE key=?');
  const sweep = statement('DELETE FROM abuse_counters WHERE key IN (SELECT key FROM abuse_counters WHERE expires<=? LIMIT 1000)');
  const size = statement('SELECT count(*) AS n FROM abuse_counters');
  const scopeSize = statement('SELECT count(*) AS n FROM abuse_counters WHERE scope=?');
  const upsert = statement('INSERT INTO abuse_counters VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, expires=excluded.expires, blocked_until=excluded.blocked_until');
  const remove = statement('DELETE FROM abuse_counters WHERE key=?');
  const row = (key: string) => select.get(key) as { count: number; expires: number; blocked_until: number } | undefined;
  /** True when the new rows (counted per scope) fit the table and each scope's share after a bounded sweep. */
  const room = (added: ReadonlyMap<string, number>, now: number, bounds: CounterBounds) => {
    sweep.run(now);
    let total = 0;
    for (const [scope, count] of added) { total += count; if (Number((scopeSize.get(scope) as { n: number }).n) + count > bounds.share) return false; }
    return Number((size.get() as { n: number }).n) + total <= bounds.maxKeys;
  };
  const transaction = <T>(work: () => T): T => {
    if (closed) throw new AbuseError(503, 'abuse_unavailable');
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch { /* the original error wins */ } throw error; }
  };
  const run = (query: StatementSync, ...values: (string | number)[]) => { if (closed) throw new AbuseError(503, 'abuse_unavailable'); return query.run(...values); };
  return {
    get closed() { return closed; },
    admit(items, now, bounds) {
      return transaction((): AbuseAdmission => {
        const rows = items.map(item => ({ item, row: row(item.key) })), live = rows.map(({ item, row }) => ({ item, row: row && row.expires > now ? row : undefined }));
        const exceeded = live.filter(({ item, row }) => row !== undefined && row.count >= item.limit);
        if (exceeded.length) return { allowed: false, status: 429, code: 'rate_limited', retryAfterSeconds: Math.ceil((Math.max(...exceeded.map(({ row }) => row!.expires)) - now) / 1000) };
        const added = new Map<string, number>();
        for (const { item, row } of rows) if (row === undefined) added.set(item.scope, (added.get(item.scope) ?? 0) + 1);
        if (added.size && !room(added, now, bounds)) return { allowed: false, status: 503, code: 'abuse_capacity' };
        let challengeRequired = false;
        for (const { item, row } of live) {
          const count = (row?.count ?? 0) + 1;
          upsert.run(item.key, count, row ? row.expires : now + item.windowMs, 0, item.scope);
          if (item.challengeAfter !== undefined && count > item.challengeAfter) challengeRequired = true;
        }
        return { allowed: true, challengeRequired };
      });
    },
    check(key, now) {
      if (closed) throw new AbuseError(503, 'abuse_unavailable');
      const found = row(key);
      return found && found.expires > now && found.blocked_until > now ? { blocked: true, retryAfterSeconds: Math.ceil((found.blocked_until - now) / 1000) } : { blocked: false, retryAfterSeconds: 0 };
    },
    failure(key, scope, spec, now, bounds) {
      transaction(() => {
        const found = row(key), live = found && found.expires > now ? found : undefined;
        if (!found && !room(new Map([[scope, 1]]), now, bounds)) throw new AbuseError(503, 'abuse_capacity');
        const count = Math.min(64, (live?.count ?? 0) + 1);
        upsert.run(key, count, now + spec.resetAfterMs, now + backoffDelay(count, spec), scope);
      });
    },
    clear(key) { run(remove, key); },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
