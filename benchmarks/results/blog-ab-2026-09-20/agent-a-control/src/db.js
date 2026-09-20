const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT
    )`);
  return db;
}

function createStore(db) {
  const now = () => new Date().toISOString();
  return {
    listAll: () => db.prepare('SELECT * FROM posts ORDER BY created_at DESC, id DESC').all(),
    listPublished: () =>
      db.prepare('SELECT * FROM posts WHERE published = 1 ORDER BY published_at DESC, id DESC').all(),
    getById: (id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id),
    getBySlug: (slug) => db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug),
    create({ title, slug, content, published }) {
      const t = now();
      const r = db
        .prepare(
          'INSERT INTO posts (title, slug, content, published, created_at, updated_at, published_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(title, slug, content, published ? 1 : 0, t, t, published ? t : null);
      return this.getById(Number(r.lastInsertRowid));
    },
    update(id, { title, slug, content }) {
      db.prepare('UPDATE posts SET title=?, slug=?, content=?, updated_at=? WHERE id=?').run(
        title, slug, content, now(), id
      );
      return this.getById(id);
    },
    setPublished(id, published) {
      const t = now();
      db.prepare(
        'UPDATE posts SET published=?, published_at=?, updated_at=? WHERE id=?'
      ).run(published ? 1 : 0, published ? t : null, t, id);
      return this.getById(id);
    },
    remove: (id) => db.prepare('DELETE FROM posts WHERE id = ?').run(id).changes > 0,
  };
}

module.exports = { openDb, createStore };
