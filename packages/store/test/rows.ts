// Direct access to a store database for tests: what the old suites did by reading and writing the JSON data files.
// Every helper opens its own connection and closes it before returning, so no handle outlives a call (Windows cannot
// remove an open database file). The server's connection may be open meanwhile: WAL readers never block it.
import { DatabaseSync } from 'node:sqlite';
import { openStoreDatabase } from '../src/database.ts';
import type { AuditEvent } from '@jimhoyd/urlcode/extensions';

type Row = Record<string, unknown>;
function withDatabase<T>(path: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { allowExtension: false });
  try { db.exec('PRAGMA busy_timeout=2000'); return work(db); } finally { db.close(); }
}

/** Creates the database (schema included) when absent, the way activation does, and closes it again. */
export async function initialize(path: string): Promise<void> { (await openStoreDatabase(path)).close(); }

/** Inserts records the way an earlier run would have stored them: `id`, `createdAt`, `updatedAt`, optional `_owner`, fields. */
export async function seed(path: string, collection: string, records: readonly Row[]): Promise<void> {
  await initialize(path);
  withDatabase(path, db => {
    const insert = db.prepare('INSERT INTO store_records(collection, id, owner, key, created_at, updated_at, data) VALUES (?, ?, ?, NULL, ?, ?, ?)');
    for (const { id, createdAt, updatedAt, _owner, ...fields } of records)
      insert.run(collection, String(id), _owner === undefined ? null : String(_owner), String(createdAt), String(updatedAt), JSON.stringify(fields));
  });
}

/** A collection's records in creation order, shaped as the API builds them plus the stored `_owner`. */
export function records(path: string, collection: string): Row[] {
  return withDatabase(path, db => db.prepare('SELECT id, owner, created_at, updated_at, data FROM store_records WHERE collection = ? ORDER BY seq').all(collection)
    .map(row => ({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.owner === null ? {} : { _owner: row.owner }), ...JSON.parse(String(row.data)) as Row })));
}

/** The audit log's events, oldest first, as recorded; all collections unless one is named. */
export function auditEvents(path: string, collection?: string): AuditEvent[] {
  return withDatabase(path, db => (collection === undefined
    ? db.prepare('SELECT id, source, action, actor, subject, at, reason, metadata FROM store_audit_events ORDER BY seq').all()
    : db.prepare("SELECT id, source, action, actor, subject, at, reason, metadata FROM store_audit_events WHERE json_extract(metadata, '$.collection') = ? ORDER BY seq").all(collection))
    .map(({ reason, metadata, ...event }) => ({ ...event, ...(reason ? { reason } : {}), ...(metadata === null ? {} : { metadata: JSON.parse(String(metadata)) }) }) as unknown as AuditEvent));
}

/** Runs raw SQL (a fault-injection trigger, a hand edit) against the database. */
export function execute(path: string, sql: string): void { withDatabase(path, db => { db.exec(sql); }); }
/** Row counts of the three tables, for "nothing was written" assertions. */
export function counts(path: string): { records: number; idempotency: number; audit: number } {
  return withDatabase(path, db => ({
    records: Number(db.prepare('SELECT count(*) AS n FROM store_records').get()!.n),
    idempotency: Number(db.prepare('SELECT count(*) AS n FROM store_idempotency').get()!.n),
    audit: Number(db.prepare('SELECT count(*) AS n FROM store_audit_events').get()!.n),
  }));
}
