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
 * revoked or rotated API key's `apikey:<id>` to its replacement or to a user), and moves the principal's membership
 * in every membership collection with them (#866). It does need the project's declared collections, to know which
 * are owned or membership lists and each one's `maxRecordsPerOwner`, and is refused as a whole rather than leaving any
 * principal over its limit.
 */
import { isAbsolute } from 'node:path';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { membershipEvent, normalize, stamp, writeAuditEvent } from './collection.ts';
import type { CollectionSpec } from './collection.ts';
import { OPERATOR_ACTOR, auditValidator } from './membership.ts';
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
/**
 * One membership collection `from` belonged to: its membership moves to `to`, or, when `to` already was a member
 * (`toWasMember`), `from`'s entry is just removed.
 */
export interface ReassignMembershipReport { collection: string; toWasMember: boolean }
export interface ReassignReport { from: string; to: string; dryRun: boolean; moved: number; collections: ReassignCollectionReport[]; memberships: ReassignMembershipReport[] }
export interface ReassignOptions {
  /** The principal id the records belong to now, exactly as stored (`apikey:<key id>`, a user id, ...). */
  from: string;
  /** The principal id they move to. */
  to: string;
  /** The project's declared store collections (`extensions.store.config.collections`); only `ownership: owner` and `membership: true` ones are touched. */
  collections: Record<string, CollectionSpec>;
  /** Limit the move to one owned or membership collection. */
  collection?: string;
  /** Report what would move and change nothing. */
  dryRun?: boolean;
}

/**
 * Moves every record owned by `from` to `to` in the owned collections (or the one named), and `from`'s membership in
 * the membership collections, in one transaction. Counts are computed for every affected collection first; when any
 * move would leave `to` holding more than that collection's `maxRecordsPerOwner`, the whole operation is refused,
 * naming the collection, and nothing is written. Otherwise every change commits together: a failure part-way (a full
 * disk, a lock held past the busy timeout, a full audit backlog) rolls back all of them, so no collection is ever
 * left moved while another is not. On an audited membership collection the change is recorded as `from` removed and
 * (unless it already was a member) `to` added, in the same transaction.
 */
export async function reassignOwner(database: string, options: ReassignOptions): Promise<ReassignReport> {
  const { from, to } = options;
  if (typeof from !== 'string' || !principalIdPattern.test(from)) throw new Error(principalMessage('--from'));
  if (typeof to !== 'string' || !principalIdPattern.test(to)) throw new Error(principalMessage('--to'));
  if (from === to) throw new Error('--from and --to name the same principal');
  if (!options.collections || typeof options.collections !== 'object') throw new Error('The project declares no store collections');
  const touched = Object.entries(options.collections).map(([name, spec]) => ({ name, spec: normalize(name, spec) })).filter(entry => entry.spec.ownership === 'owner' || entry.spec.membership);
  let selected = touched;
  if (options.collection !== undefined) {
    if (!Object.hasOwn(options.collections, options.collection)) throw new Error(`Collection ${options.collection} is not declared`);
    selected = touched.filter(entry => entry.name === options.collection);
    if (!selected.length) throw new Error(`Collection ${options.collection} is not declared with ownership: owner or membership: true`);
  }
  if (!selected.length) throw new Error('The project declares no collection with ownership: owner or membership: true');
  const lists = selected.filter(entry => entry.spec.membership);
  const audited = lists.find(entry => entry.spec.audit);
  const validate = audited ? await auditValidator(audited.name) : undefined;
  return transaction(database, db => {
    const member = (collection: string, principal: string) => db.get<{ id: string; updated_at: string }>('SELECT id, updated_at FROM store_records WHERE collection = ? AND key = ?', collection, principal);
    const memberships: ReassignMembershipReport[] = lists.filter(({ name }) => member(name, from) !== undefined).map(({ name }) => ({ collection: name, toWasMember: member(name, to) !== undefined }));
    // Membership first: `from`'s entry becomes `to`'s (the key column and the key field together), or goes when `to`
    // already has one. A membership list has no per-owner limit and never grows here.
    if (!options.dryRun) for (const report of memberships) {
      const { spec } = lists.find(entry => entry.name === report.collection)!, row = member(report.collection, from)!;
      if (report.toWasMember) db.run('DELETE FROM store_records WHERE collection = ? AND id = ?', report.collection, row.id);
      else db.run('UPDATE store_records SET key = ?, updated_at = ?, data = json_set(data, ?, ?) WHERE collection = ? AND id = ?', to, stamp(row.updated_at), `$.${spec.key!}`, to, report.collection, row.id);
      if (spec.audit) {
        writeAuditEvent(db, report.collection, validate!, membershipEvent(report.collection, 'removed', from, OPERATOR_ACTOR));
        if (!report.toWasMember) writeAuditEvent(db, report.collection, validate!, membershipEvent(report.collection, 'added', to, OPERATOR_ACTOR));
      }
    }
    const count = (collection: string, owner: string) => db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', collection, owner)!.n;
    // A declared collection that holds no records yet has nothing to move and is left out of the report.
    const collections: ReassignCollectionReport[] = selected.filter(({ name, spec }) => spec.ownership === 'owner' && total(db, name) > 0).map(({ name, spec }) => {
      const moved = count(name, from), toBefore = count(name, to);
      return { collection: name, moved, toBefore, toAfter: toBefore + moved, maxRecordsPerOwner: spec.maxRecordsPerOwner ?? null };
    });
    const over = collections.filter(report => report.moved > 0 && report.maxRecordsPerOwner !== null && report.toAfter > report.maxRecordsPerOwner);
    if (over.length) throw new Error(`Nothing was moved: ${over.map(report => `collection ${report.collection} would give ${to} ${report.toAfter} records, over its maxRecordsPerOwner of ${report.maxRecordsPerOwner}`).join('; ')}. Delete or reassign some of its records first, or raise the limit.`);
    if (!options.dryRun) for (const report of collections) if (report.moved > 0) db.run('UPDATE store_records SET owner = ? WHERE collection = ? AND owner = ?', to, report.collection, from);
    return { from, to, dryRun: options.dryRun === true, moved: collections.reduce((sum, report) => sum + report.moved, 0), collections, memberships };
  });
}
