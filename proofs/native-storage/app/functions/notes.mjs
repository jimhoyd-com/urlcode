// Trusted application code: the owner's storage choice, called directly. This is Node's built-in node:sqlite and its
// own API (DatabaseSync, prepared statements, a transaction), with no URLCode store, adapter or descriptor between
// the route and the database. URLCode has already routed the request, validated its body and parameters and, for
// `auth: true`, verified the session: the function reads only the signed-in user's id and the data directory the
// operator granted. Replacing node:sqlite with another library changes this file and nothing in urlcode.yaml.
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = `
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_by_owner ON notes (owner, created_at);`;
const noStore = { 'cache-control': 'no-store' };

/** Opens the owner's database for one request and closes it afterwards. The file lives in the operator's data directory, never in the project. */
function withDatabase(env, work) {
  const directory = env.DATA_DIR;
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('notes: URLCODE_DATA_DIR must name an absolute directory outside the project');
  const database = new DatabaseSync(join(directory, 'notes.sqlite'));
  try {
    database.exec(`PRAGMA busy_timeout = 5000; ${schema}`);
    return work(database);
  } finally { database.close(); }
}

/** The verified user id `auth: true` hands a trusted route that names the provider. */
const ownerOf = context => context.capabilities?.authjs?.identity?.userId;

/** GET /api/notes lists the caller's notes, oldest first; POST adds one. */
export default async function notes(request, context) {
  const owner = ownerOf(context);
  if (!owner) return Response.json({ error: 'authentication_required' }, { status: 401, headers: noStore });
  if (request.method === 'POST') {
    // The body already matched the route's declared schema, so only the stored shape is decided here.
    const { title, body = '' } = await request.json();
    const note = { id: randomUUID(), title, body, createdAt: new Date().toISOString() };
    withDatabase(context.env, database => {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('INSERT INTO notes (id, owner, title, body, created_at) VALUES (?, ?, ?, ?, ?)').run(note.id, owner, note.title, note.body, note.createdAt);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    });
    return Response.json(note, { status: 201, headers: { ...noStore, location: `/api/notes/${note.id}` } });
  }
  const items = withDatabase(context.env, database => database
    .prepare('SELECT id, title, body, created_at AS createdAt FROM notes WHERE owner = ? ORDER BY created_at, rowid')
    .all(owner));
  return Response.json({ items, total: items.length }, { headers: noStore });
}

/** GET /api/notes/{id}: the caller's own note; another owner's note is indistinguishable from a missing one. */
export function note(_request, context) {
  const owner = ownerOf(context);
  if (!owner) return Response.json({ error: 'authentication_required' }, { status: 401, headers: noStore });
  const row = withDatabase(context.env, database => database
    .prepare('SELECT id, title, body, created_at AS createdAt FROM notes WHERE id = ? AND owner = ?')
    .get(context.args.id, owner));
  return row ? Response.json({ ...row }, { headers: noStore }) : Response.json({ error: 'not_found' }, { status: 404, headers: noStore });
}
