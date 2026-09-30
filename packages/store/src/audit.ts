// The audit log (#1052): events the store records in its own database, in the same BEGIN IMMEDIATE transaction as
// the change they describe, so an event exists exactly when its change committed. The newest `auditRetention` events
// are kept, pruned in that same transaction. Operators read it with `urlcode-store audit`; a sink pulls it through the
// tap (core's `AuditTap`: `peek`, then `ack`) to forward it anywhere. Every statement is indexed and bounded.
import { randomUUID } from 'node:crypto';
import { AuditError, auditLimits, validateAuditEvent, validateAuditQuery } from '@jimhoyd/urlcode/extensions';
import type { AuditLog, AuditPage, AuditQuery, AuditStoredEvent, AuditValue, NormalizedAuditQuery } from '@jimhoyd/urlcode/extensions';
import type { SQLInputValue } from 'node:sqlite';
import type { StoreDatabase } from './database.ts';

/** How many of the newest events the log keeps (`extensions.store.config.auditRetention`). */
export const AUDIT_RETENTION = Object.freeze({ default: 100_000, min: 1_000, max: 10_000_000 } as const);
/** What one store write records: everything but the id, source and time, which the store fills in. */
export interface AuditBody { action: string; actor: string; subject: string; metadata: Record<string, unknown> }

/**
 * Records one store event inside the caller's open write transaction, after core's validator accepted it, and prunes
 * the log to its newest `retention` events. A failure rolls the caller's change back too.
 */
export function recordAuditEvent(db: StoreDatabase, body: AuditBody, retention: number): void {
  const event = validateAuditEvent({ id: randomUUID(), source: 'store', at: Date.now(), ...body });
  db.run('INSERT INTO store_audit_events(id, source, action, actor, subject, at, reason, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    event.id, event.source, event.action, event.actor, event.subject, event.at, event.reason ?? '', event.metadata === undefined ? null : JSON.stringify(event.metadata));
  db.run('DELETE FROM store_audit_events WHERE seq <= (SELECT max(seq) - ? FROM store_audit_events)', retention);
}

interface Row { seq: number; id: string; source: string; action: string; actor: string; subject: string; at: number; reason: string; metadata: string | null }
const COLUMNS = 'seq, id, source, action, actor, subject, at, reason, metadata';
function stored(row: Row): AuditStoredEvent {
  return Object.freeze({
    id: row.id, source: row.source, action: row.action, actor: row.actor, subject: row.subject, at: Number(row.at), reason: row.reason,
    metadata: row.metadata === null ? null : JSON.parse(row.metadata) as Readonly<Record<string, AuditValue>>, seq: String(row.seq),
  });
}

/** One page of the log matching `query`, in record order (or newest first), with the cursor of the next page. */
export function queryAudit(db: StoreDatabase, query: NormalizedAuditQuery): AuditPage {
  const where: string[] = [], params: SQLInputValue[] = [];
  for (const column of ['source', 'actor', 'subject', 'action'] as const) {
    const value = query[column];
    if (value !== undefined) { where.push(`${column} = ?`); params.push(value); }
  }
  // "." (0x2e) and "/" (0x2f) are adjacent, so this range is exactly the actions starting with prefix + ".", and it
  // uses the action index with no LIKE wildcard ("_" is a legal action character).
  if (query.actionPrefix !== undefined) { where.push('(action = ? OR (action >= ? AND action < ?))'); params.push(query.actionPrefix, `${query.actionPrefix}.`, `${query.actionPrefix}/`); }
  if (query.from !== undefined) { where.push('at >= ?'); params.push(query.from); }
  if (query.to !== undefined) { where.push('at <= ?'); params.push(query.to); }
  if (query.after !== undefined) { where.push(query.order === 'asc' ? 'seq > ?' : 'seq < ?'); params.push(query.after); }
  const rows = db.all<Row>(`SELECT ${COLUMNS} FROM store_audit_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ${query.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`, ...params, query.limit + 1).map(stored);
  const oldest = db.get<{ seq: number | null }>('SELECT min(seq) AS seq FROM store_audit_events')?.seq;
  const events = rows.slice(0, query.limit);
  return Object.freeze({
    events,
    ...(rows.length > query.limit ? { next: events[events.length - 1]!.seq } : {}),
    ...(oldest === null || oldest === undefined ? {} : { oldest: String(oldest) }),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function batchLimit(limit: unknown): number {
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > auditLimits.batch) throw new AuditError(400, 'invalid_audit_query', `peek takes a limit of 1 to ${auditLimits.batch}`);
  return limit as number;
}
function eventIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > auditLimits.batch || !ids.every(id => typeof id === 'string' && UUID.test(id))) throw new AuditError(400, 'invalid_audit_query', `ack takes at most ${auditLimits.batch} event ids`);
  return ids as string[];
}

/**
 * The store's audit log as core's `AuditLog`: the tap and the query over the database the serving activation holds.
 * `current()` is that database, or undefined while the store is not active, when every call rejects with 503
 * `audit_inactive`. `ack` is one write transaction.
 */
export function auditLog(current: () => StoreDatabase | undefined): AuditLog {
  const database = (): StoreDatabase => {
    const db = current();
    if (!db) throw new AuditError(503, 'audit_inactive', 'The store is not active');
    return db;
  };
  const guarded = async <T>(work: () => T): Promise<T> => {
    try { return work(); }
    catch (error) { if (error instanceof AuditError) throw error; throw new AuditError(503, 'audit_unavailable', 'The audit log is unavailable'); }
  };
  return Object.freeze({
    peek: (limit: number) => guarded(() => { const max = batchLimit(limit); return database().all<Row>(`SELECT ${COLUMNS} FROM store_audit_events WHERE forwarded = 0 ORDER BY seq LIMIT ?`, max).map(stored); }),
    ack: (ids: readonly string[]) => guarded(() => {
      const list = eventIds(ids), db = database();
      return list.length ? db.transaction(() => db.run('UPDATE store_audit_events SET forwarded = 1 WHERE forwarded = 0 AND id IN (SELECT value FROM json_each(?))', JSON.stringify(list))) : 0;
    }),
    query: (filter?: AuditQuery) => guarded(() => { const query = validateAuditQuery(filter); return queryAudit(database(), query); }),
  });
}
