// Reads a collection's records straight from the store's SQLite database, the way these suites once read the store's
// JSON data file: in creation order, with the stored `_owner`. The connection is closed before returning.
import { DatabaseSync } from 'node:sqlite';

export function storedRecords(database: string, collection: string): Record<string, unknown>[] {
  const db = new DatabaseSync(database);
  try {
    return db.prepare('SELECT id, owner, data FROM store_records WHERE collection = ? ORDER BY seq').all(collection)
      .map(row => ({ id: row.id, ...(row.owner === null ? {} : { _owner: row.owner }), ...JSON.parse(String(row.data)) as Record<string, unknown> }));
  } finally { db.close(); }
}
