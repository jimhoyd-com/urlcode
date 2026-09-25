// The audit log: one SQLite file on the main thread. Every statement is indexed and bounded (batches of at most
// 100 events, pages of at most 100 rows), and a write resolves only after a durable commit (synchronous=FULL).
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AuditError } from './types.ts';
import type { AuditEvent, AuditPage, AuditStoredEvent, AuditValue } from './types.ts';
import type { NormalizedQuery } from './event.ts';

/** PRAGMA application_id of an audit database: "UAUD". */
export const AUDIT_APPLICATION_ID = 0x55415544;
export const AUDIT_SCHEMA_VERSION = 1;

/** SQLite releases with the fixes URLCode's SQLite stores require (the same rule as auth's store). */
export function patched(version: string): boolean { const [a = 0, b = 0, c = 0] = version.split('.').map(Number); return a > 3 || a === 3 && (b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6); }

const SCHEMA = `CREATE TABLE audit_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE audit_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
  action TEXT NOT NULL, actor TEXT NOT NULL, subject TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL,
  metadata TEXT, recorded_at INTEGER NOT NULL);
CREATE INDEX audit_actor ON audit_events(actor, seq); CREATE INDEX audit_subject ON audit_events(subject, seq);
CREATE INDEX audit_action ON audit_events(action, seq); CREATE INDEX audit_source ON audit_events(source, seq);
CREATE INDEX audit_at ON audit_events(at);`;

export interface AuditStore {
  /** Stores validated events once each (INSERT OR IGNORE on id) and prunes past `retention`, in one transaction. Returns the pruned count. */
  ingest(events: readonly AuditEvent[], retention: number, recordedAt: number): number;
  query(query: NormalizedQuery): AuditPage;
  close(): void;
}

function unavailable(): AuditError { return new AuditError(503, 'audit_unavailable', 'The audit log is unavailable'); }

/**
 * Refuses a path that is not a private regular file: a symlink, a hard-linked file (nlink != 1) or one with a group
 * or other permission bit. Creates it 0600 first when `create` is set and it is absent.
 */
async function privateFile(path: string, create: boolean): Promise<string> {
  const requested = resolve(path), parent = await realpath(dirname(requested)), database = join(parent, basename(requested));
  if (create) {
    try { await (await open(database, 'wx', 0o600)).close(); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
  const info = await lstat(database);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new Error('The audit database must be a private regular file (mode 0600, not a link)');
  return database;
}

function checkIdentity(db: DatabaseSync): 'empty' | 'audit' {
  const version = db.prepare('PRAGMA user_version').get()?.user_version, application = db.prepare('PRAGMA application_id').get()?.application_id;
  const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master").get()?.n === 0;
  if (version === 0 && application === 0 && empty) return 'empty';
  if (version !== AUDIT_SCHEMA_VERSION || application !== AUDIT_APPLICATION_ID) throw new Error('Not an audit database, or an unsupported audit schema version');
  return 'audit';
}

function row(value: Record<string, SQLInputValue>): AuditStoredEvent {
  return {
    id: String(value.id), source: String(value.source), action: String(value.action), actor: String(value.actor), subject: String(value.subject),
    at: Number(value.at), reason: String(value.reason),
    metadata: value.metadata === null ? null : JSON.parse(String(value.metadata)) as Readonly<Record<string, AuditValue>>,
    seq: String(value.seq), recordedAt: Number(value.recorded_at),
  };
}

function queryAudit(db: DatabaseSync, query: NormalizedQuery): AuditPage {
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
  const sql = `SELECT seq, id, source, action, actor, subject, at, reason, metadata, recorded_at FROM audit_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ${query.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`;
  const rows = db.prepare(sql).all(...params, query.limit + 1).map(row);
  const oldest = db.prepare('SELECT min(seq) AS seq FROM audit_events').get()?.seq;
  const events = rows.slice(0, query.limit);
  return {
    events,
    ...(rows.length > query.limit ? { next: events[events.length - 1]!.seq } : {}),
    ...(oldest === null || oldest === undefined ? {} : { oldest: String(oldest) }),
  };
}

/** Opens (creating when absent) the audit database for the host. */
export async function openAuditStore(path: string, onPruned?: (removed: number) => void): Promise<AuditStore> {
  if (!patched(process.versions.sqlite || '')) throw new Error(`The audit log requires a patched SQLite (3.44.6, 3.50.7, 3.51.3 or newer); this Node has ${process.versions.sqlite || 'none'}`);
  const database = await privateFile(path, true);
  const db = new DatabaseSync(database, { allowExtension: false });
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF;');
    const state = checkIdentity(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (state === 'empty') {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(SCHEMA);
        db.prepare("INSERT INTO audit_meta(key, value) VALUES ('schema', ?)").run(String(AUDIT_SCHEMA_VERSION));
        db.exec(`PRAGMA application_id=${AUDIT_APPLICATION_ID}; PRAGMA user_version=${AUDIT_SCHEMA_VERSION};`);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  } catch (error) { db.close(); throw error; }
  const insert = db.prepare('INSERT OR IGNORE INTO audit_events(id, source, action, actor, subject, at, reason, metadata, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM audit_events WHERE seq <= (SELECT max(seq) - ? FROM audit_events)');
  return {
    ingest(events, retention, recordedAt) {
      if (closed) throw unavailable();
      let removed: number;
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const event of events)
            insert.run(event.id, event.source, event.action, event.actor, event.subject, event.at, event.reason ?? '', event.metadata === undefined ? null : JSON.stringify(event.metadata), recordedAt);
          removed = Number(prune.run(retention).changes);
          db.exec('COMMIT');
        } catch (error) { try { db.exec('ROLLBACK'); } catch { /* No open transaction. */ } throw error; }
      } catch { throw unavailable(); }
      if (removed > 0 && onPruned) try { onPruned(removed); } catch { /* Best effort: never affects the store. */ }
      return removed;
    },
    query(query) {
      if (closed) throw unavailable();
      try { return queryAudit(db, query); } catch { throw unavailable(); }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

/** Opens an existing audit database read-only (the CLI's `list`): never creates, migrates or writes it. */
export async function openAuditReader(path: string): Promise<{ query(query: NormalizedQuery): AuditPage; close(): void }> {
  if (!patched(process.versions.sqlite || '')) throw new Error('The audit log requires a patched SQLite');
  const database = await privateFile(path, false);
  const db = new DatabaseSync(database, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    if (checkIdentity(db) !== 'audit') throw new Error('Not an audit database');
  } catch (error) { db.close(); throw error; }
  return { query: query => queryAudit(db, query), close: () => db.close() };
}
