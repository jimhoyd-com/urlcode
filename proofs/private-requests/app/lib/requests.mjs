// The application's own data: requests and who may review them, in one SQLite database.
// Direct parameterized SQL for this proof; #835 owns the durable transition/idempotency design.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const schema = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved')),
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS requests_by_owner ON requests (owner_id, created_at);
CREATE TABLE IF NOT EXISTS reviewers (user_id TEXT PRIMARY KEY);
`;
const databases = new Map();

/** The application database at `path`, opened once per process with its tables created. */
export function database(path) {
  let db = databases.get(path);
  if (!db) {
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
    db.exec(schema);
    databases.set(path, db);
  }
  return db;
}

/** The verified caller from the better-auth capability, never from the request. */
export function caller(context) {
  return context.capabilities?.['better-auth']?.identity?.userId ?? null;
}

export function isReviewer(db, userId) {
  return db.prepare('SELECT 1 FROM reviewers WHERE user_id = ?').get(userId) !== undefined;
}

const view = row => row && {
  id: row.id, ownerId: row.owner_id, title: row.title, details: row.details, status: row.status,
  createdAt: row.created_at, reviewedAt: row.reviewed_at ?? null,
};

export function listOwn(db, ownerId, status) {
  if (status) return db.prepare('SELECT * FROM requests WHERE owner_id = ? AND status = ? ORDER BY created_at DESC, id').all(ownerId, status).map(view);
  return db.prepare('SELECT * FROM requests WHERE owner_id = ? ORDER BY created_at DESC, id').all(ownerId).map(view);
}

export function listPending(db) {
  return db.prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at, id").all().map(view);
}

export function find(db, id) {
  return view(db.prepare('SELECT * FROM requests WHERE id = ?').get(id));
}

export function create(db, ownerId, { title, details = '' }) {
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare("INSERT INTO requests (id, owner_id, title, details, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(id, ownerId, title, details, now);
  return find(db, id);
}

/** pending -> approved in one conditional statement: exactly one concurrent approval can win. */
export function approve(db, id, reviewerId) {
  const { changes } = db.prepare("UPDATE requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending' AND owner_id <> ?").run(reviewerId, new Date().toISOString(), id, reviewerId);
  return changes === 1;
}

export const json = (status, value) => Response.json(value, { status });
