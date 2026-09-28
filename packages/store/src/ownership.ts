/**
 * The operator step for records that carry no owner on an `ownership: owner` collection (urlcode#331): records
 * written while the collection was still declared shared. An owned collection serves a record only to the principal
 * stamped on it, so such a record is served to nobody. The store never guesses an owner for it: the operator reports
 * such records and then either assigns them to one named principal or deletes them.
 *
 * Every command here is one SQLite transaction on its own connection to the store database, so it is safe to run
 * while the server is serving: the server reads the database on every request and sees the change on its next one.
 * They do not read the project; re-validation against the declared fields happens, as always, when the store next
 * activates.
 *
 * `reassignOwner` (urlcode#732) is the other operator step: it moves every record one principal owns to another (a
 * revoked or rotated API key's `apikey:<id>` to its replacement or to a user). It does need the project's declared
 * collections, to know which are owned and each one's `maxRecordsPerOwner`, and is refused as a whole rather than
 * leaving any principal over its limit.
 */
import { isAbsolute } from 'node:path';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { normalize } from './collection.ts';
import type { CollectionSpec } from './collection.ts';
import { openStoreDatabase } from './database.ts';
import type { StoreDatabase } from './database.ts';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export interface OwnerlessReport { collection: string; records: number; ownerless: number; ids: string[] }

/** Opens an existing store database (never creates one), runs `work` in one write transaction and closes it. */
async function transaction<T>(database: string, work: (db: StoreDatabase) => T): Promise<T> {
  if (typeof database !== 'string' || !isAbsolute(database)) throw new Error('Store database must be an absolute path');
  const db = await openStoreDatabase(database, { create: false });
  try { return db.transaction(() => work(db)); } finally { db.close(); }
}
function named(collection: string): string { if (typeof collection !== 'string' || !NAME.test(collection)) throw new Error('Collection name is not valid'); return collection; }
const total = (db: StoreDatabase, collection: string): number => db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ?', collection)!.n;
const ownerlessIds = (db: StoreDatabase, collection: string): string[] => db.all<{ id: string }>('SELECT id FROM store_records WHERE collection = ? AND owner IS NULL ORDER BY seq', collection).map(row => row.id);

/** Counts (and lists the ids of) a collection's records that carry no owner. Changes nothing. */
export async function reportOwnerless(database: string, collection: string): Promise<OwnerlessReport> {
  named(collection);
  return transaction(database, db => { const ids = ownerlessIds(db, collection); return { collection, records: total(db, collection), ownerless: ids.length, ids }; });
}
/**
 * Stamps `owner` (a principal id, exactly as the principal provider sets it: for auth, the user id, or
 * `apikey:<key id>` for a bearer key) on every record that has none. Records that already have an owner are untouched.
 */
export async function assignOwnerless(database: string, collection: string, owner: string): Promise<OwnerlessReport> {
  if (typeof owner !== 'string' || !principalIdPattern.test(owner)) throw new Error('Owner must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit');
  named(collection);
  return transaction(database, db => {
    const ids = ownerlessIds(db, collection);
    db.run('UPDATE store_records SET owner = ? WHERE collection = ? AND owner IS NULL', owner, collection);
    return { collection, records: total(db, collection), ownerless: 0, ids };
  });
}
/** Deletes every record that has no owner. Records that have one are untouched. */
export async function deleteOwnerless(database: string, collection: string): Promise<OwnerlessReport> {
  named(collection);
  return transaction(database, db => {
    const ids = ownerlessIds(db, collection);
    db.run('DELETE FROM store_records WHERE collection = ? AND owner IS NULL', collection);
    return { collection, records: total(db, collection), ownerless: 0, ids };
  });
}

const principalMessage = (flag: string) => `${flag} must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit`;
export interface ReassignCollectionReport { collection: string; moved: number; toBefore: number; toAfter: number; maxRecordsPerOwner: number | null }
export interface ReassignReport { from: string; to: string; dryRun: boolean; moved: number; collections: ReassignCollectionReport[] }
export interface ReassignOptions {
  /** The principal id the records belong to now, exactly as stored (`apikey:<key id>`, a user id, ...). */
  from: string;
  /** The principal id they move to. */
  to: string;
  /** The project's declared store collections (`extensions.store.config.collections`); only `ownership: owner` ones are touched. */
  collections: Record<string, CollectionSpec>;
  /** Limit the move to one owned collection. */
  collection?: string;
  /** Report what would move and change nothing. */
  dryRun?: boolean;
}

/**
 * Moves every record owned by `from` to `to` in the owned collections (or the one named), in one transaction.
 * Counts are computed for every affected collection first; when any move would leave `to` holding more than that
 * collection's `maxRecordsPerOwner`, the whole operation is refused, naming the collection, and nothing is written.
 * Otherwise every collection's records move together: a failure part-way (a full disk, a lock held past the busy
 * timeout) rolls back all of them, so no collection is ever left moved while another is not.
 */
export async function reassignOwner(database: string, options: ReassignOptions): Promise<ReassignReport> {
  const { from, to } = options;
  if (typeof from !== 'string' || !principalIdPattern.test(from)) throw new Error(principalMessage('--from'));
  if (typeof to !== 'string' || !principalIdPattern.test(to)) throw new Error(principalMessage('--to'));
  if (from === to) throw new Error('--from and --to name the same principal');
  if (!options.collections || typeof options.collections !== 'object') throw new Error('The project declares no store collections');
  const owned = Object.entries(options.collections).map(([name, spec]) => ({ name, spec: normalize(name, spec) })).filter(entry => entry.spec.ownership === 'owner');
  let selected = owned;
  if (options.collection !== undefined) {
    if (!Object.hasOwn(options.collections, options.collection)) throw new Error(`Collection ${options.collection} is not declared`);
    selected = owned.filter(entry => entry.name === options.collection);
    if (!selected.length) throw new Error(`Collection ${options.collection} is not declared with ownership: owner`);
  }
  if (!selected.length) throw new Error('The project declares no collection with ownership: owner');
  return transaction(database, db => {
    const count = (collection: string, owner: string) => db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', collection, owner)!.n;
    // A declared collection that holds no records yet has nothing to move and is left out of the report.
    const collections: ReassignCollectionReport[] = selected.filter(({ name }) => total(db, name) > 0).map(({ name, spec }) => {
      const moved = count(name, from), toBefore = count(name, to);
      return { collection: name, moved, toBefore, toAfter: toBefore + moved, maxRecordsPerOwner: spec.maxRecordsPerOwner ?? null };
    });
    const over = collections.filter(report => report.moved > 0 && report.maxRecordsPerOwner !== null && report.toAfter > report.maxRecordsPerOwner);
    if (over.length) throw new Error(`Nothing was moved: ${over.map(report => `collection ${report.collection} would give ${to} ${report.toAfter} records, over its maxRecordsPerOwner of ${report.maxRecordsPerOwner}`).join('; ')}. Delete or reassign some of its records first, or raise the limit.`);
    if (!options.dryRun) for (const report of collections) if (report.moved > 0) db.run('UPDATE store_records SET owner = ? WHERE collection = ? AND owner = ?', to, report.collection, from);
    return { from, to, dryRun: options.dryRun === true, moved: collections.reduce((sum, report) => sum + report.moved, 0), collections };
  });
}
