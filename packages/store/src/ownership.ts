/**
 * The operator step for records that carry no owner on an `ownership: owner` collection (urlcode#331): records
 * written while the collection was still declared shared. An owned collection serves a record only to the principal
 * stamped on it, so such a record is served to nobody. The store never guesses an owner for it: the operator reports
 * such records and then either assigns them to one named principal or deletes them.
 *
 * Every command here is one SQLite transaction on its own connection to the store database, so it is safe to run
 * while the server is serving: the server reads the database on every request and sees the change on its next one.
 * The report only reads the database; assigning and deleting take the project's declared collections, to know that
 * the collection is owned and whether it is audited. Re-validation against the declared fields happens, as always,
 * when the store next activates.
 *
 * `reassignOwner` (urlcode#732) is the other operator step: it moves every record one principal owns to another (a
 * revoked or rotated API key's `apikey:<id>` to its replacement or to a user), and moves the principal's membership
 * in every membership collection with them (#866). It needs the declared collections to know which are owned or
 * membership lists and each one's `maxRecordsPerOwner`, and is refused as a whole rather than leaving any principal
 * over its limit.
 *
 * Audit (#875): on a collection declared `audit: true`, every record an operator command moves or deletes writes one
 * outbox event in the same transaction, with the actor `operator` or the operator's `--actor` (operator-asserted, not
 * authenticated): `store.record.reassigned` (subject `<collection>/<id>`, metadata `{collection, from?, to}`, the
 * opaque principal ids as membership events carry them; `from` is absent for a record that had no owner) or
 * `store.record.deleted` (metadata `{collection, ownerless: true}`). The counts are known before anything is written,
 * so a change that would take a collection's outbox past its backlog (`AUDIT_BACKLOG` events waiting) is refused
 * whole with 503 `audit_backlog`, a dry run included, and nothing is written. One command can therefore change at most
 * `AUDIT_BACKLOG` records of one audited collection.
 */
import { isAbsolute } from 'node:path';
import type { AuditEvent } from '@jimhoyd/urlcode-audit';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { AUDIT_BACKLOG, StoreError, membershipEvent, normalize, stamp, writeAuditEvent } from './collection.ts';
import type { CollectionSpec, NormalizedSpec } from './collection.ts';
import { auditValidator, operatorActor } from './membership.ts';
import { auditDelivery, openStoreDatabase } from './database.ts';
import type { AuditDelivery, StoreDatabase } from './database.ts';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** On an `audit: true` collection, assigning and deleting also report the outbox delivery status (`AuditDelivery`). */
export type OwnerlessReport = { collection: string; records: number; ownerless: number; ids: string[] } & Partial<AuditDelivery>;
export interface OwnerlessOptions {
  /** The project's declared store collections (`extensions.store.config.collections`). */
  collections: Record<string, CollectionSpec>;
  /** A declared collection with `ownership: owner`. */
  collection: string;
  /** The audit actor recorded on an `audit: true` collection (a principal id; default `operator`). Operator-asserted, not authenticated. */
  actor?: string;
}

/** Opens an existing store database (never creates one), runs `work` in one write transaction and closes it. */
async function transaction<T>(database: string, work: (db: StoreDatabase) => T): Promise<T> {
  if (typeof database !== 'string' || !isAbsolute(database)) throw new Error('Store database must be an absolute path');
  const db = await openStoreDatabase(database, { create: false });
  try { return db.transaction(() => work(db)); } finally { db.close(); }
}
function named(collection: string): string { if (typeof collection !== 'string' || !NAME.test(collection)) throw new Error('Collection name is not valid'); return collection; }
const total = (db: StoreDatabase, collection: string): number => db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ?', collection)!.n;
const ownerlessIds = (db: StoreDatabase, collection: string): string[] => db.all<{ id: string }>('SELECT id FROM store_records WHERE collection = ? AND owner IS NULL ORDER BY seq', collection).map(row => row.id);
const ownedIds = (db: StoreDatabase, collection: string, owner: string): string[] => db.all<{ id: string }>('SELECT id FROM store_records WHERE collection = ? AND owner = ? ORDER BY seq', collection, owner).map(row => row.id);

type Validate = (value: unknown) => AuditEvent;
/**
 * Refuses, before anything is written, a change that would record `planned` events in a collection past its backlog:
 * the same 503 `audit_backlog` a write at the cap answers, by the same count `writeAuditEvent` checks per event.
 */
function assertBacklog(db: StoreDatabase, planned: ReadonlyMap<string, number>): void {
  for (const [collection, events] of planned) {
    if (!events) continue;
    const waiting = db.get<{ n: number }>('SELECT count(*) AS n FROM store_audit_outbox WHERE collection = ?', collection)!.n;
    if (waiting + events <= AUDIT_BACKLOG) continue;
    const advice = events > AUDIT_BACKLOG ? 'One command cannot record that many; change fewer records at a time.' : 'Let the serving process\'s audit drain deliver them, then run it again.';
    throw new StoreError(503, 'audit_backlog', `Nothing was changed: collection ${collection} would record ${events} audit events with ${waiting} already waiting, over its audit backlog of ${AUDIT_BACKLOG}. ${advice}`);
  }
}
const reassignedEvent = (collection: string, id: string, from: string | undefined, to: string, actor: string) =>
  ({ action: 'store.record.reassigned', actor, subject: `${collection}/${id}`, metadata: { collection, ...(from === undefined ? {} : { from }), to } });

/** The declared `ownership: owner` collection an ownerless command names, and audit's validator when it is audited. */
async function ownedCollection(options: OwnerlessOptions): Promise<{ collection: string; validate: Validate | undefined; actor: string }> {
  if (!options?.collections || typeof options.collections !== 'object') throw new Error('The project declares no store collections');
  const collection = named(options.collection), actor = operatorActor(options.actor);
  if (!Object.hasOwn(options.collections, collection)) throw new Error(`Collection ${collection} is not declared`);
  const spec = normalize(collection, options.collections[collection]!);
  if (spec.ownership !== 'owner') throw new Error(`Collection ${collection} is not declared with ownership: owner`);
  return { collection, validate: spec.audit ? await auditValidator(collection) : undefined, actor };
}

/** Counts (and lists the ids of) a collection's records that carry no owner. Changes nothing. */
export async function reportOwnerless(database: string, collection: string): Promise<OwnerlessReport> {
  named(collection);
  return transaction(database, db => { const ids = ownerlessIds(db, collection); return { collection, records: total(db, collection), ownerless: ids.length, ids }; });
}
/**
 * Stamps `owner` (a principal id, exactly as the principal provider sets it: for auth, the user id, or
 * `apikey:<key id>` for a bearer key) on every record that has none. Records that already have an owner are untouched.
 */
export async function assignOwnerless(database: string, options: OwnerlessOptions & { owner: string }): Promise<OwnerlessReport> {
  const owner = options?.owner;
  if (typeof owner !== 'string' || !principalIdPattern.test(owner)) throw new Error('Owner must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit');
  const { collection, validate, actor } = await ownedCollection(options);
  return transaction(database, db => {
    const ids = ownerlessIds(db, collection);
    if (validate) assertBacklog(db, new Map([[collection, ids.length]]));
    db.run('UPDATE store_records SET owner = ? WHERE collection = ? AND owner IS NULL', owner, collection);
    if (validate) for (const id of ids) writeAuditEvent(db, collection, validate, reassignedEvent(collection, id, undefined, owner, actor));
    return { collection, records: total(db, collection), ownerless: 0, ids, ...(validate ? auditDelivery(db, [collection], Date.now()) : {}) };
  });
}
/** Deletes every record that has no owner. Records that have one are untouched. */
export async function deleteOwnerless(database: string, options: OwnerlessOptions): Promise<OwnerlessReport> {
  const { collection, validate, actor } = await ownedCollection(options);
  return transaction(database, db => {
    const ids = ownerlessIds(db, collection);
    if (validate) assertBacklog(db, new Map([[collection, ids.length]]));
    db.run('DELETE FROM store_records WHERE collection = ? AND owner IS NULL', collection);
    if (validate) for (const id of ids) writeAuditEvent(db, collection, validate, { action: 'store.record.deleted', actor, subject: `${collection}/${id}`, metadata: { collection, ownerless: true } });
    return { collection, records: total(db, collection), ownerless: 0, ids, ...(validate ? auditDelivery(db, [collection], Date.now()) : {}) };
  });
}

const principalMessage = (flag: string) => `${flag} must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit`;
export interface ReassignCollectionReport { collection: string; moved: number; toBefore: number; toAfter: number; maxRecordsPerOwner: number | null }
/**
 * One membership collection `from` belonged to: its membership moves to `to`, or, when `to` already was a member
 * (`toWasMember`), `from`'s entry is just removed.
 */
export interface ReassignMembershipReport { collection: string; toWasMember: boolean }
/**
 * `auditEvents`: how many audit events the move records (or, on a dry run, would record) across the audited collections.
 * When it records any (not on a dry run), the report also carries the outbox delivery status of those collections.
 */
export type ReassignReport = { from: string; to: string; dryRun: boolean; moved: number; auditEvents: number; collections: ReassignCollectionReport[]; memberships: ReassignMembershipReport[] } & Partial<AuditDelivery>;
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
  /** The audit actor recorded on `audit: true` collections (a principal id; default `operator`). Operator-asserted, not authenticated. */
  actor?: string;
}

/**
 * Moves every record owned by `from` to `to` in the owned collections (or the one named), and `from`'s membership in
 * the membership collections, in one transaction. Counts are computed for every affected collection first; when any
 * move would leave `to` holding more than that collection's `maxRecordsPerOwner`, or would take an audited
 * collection's outbox past its backlog, the whole operation is refused, naming the collection, and nothing is written.
 * Otherwise every change commits together with its audit events: a failure part-way (a full disk, a lock held past
 * the busy timeout) rolls back all of it, so no collection is ever left moved while another is not. On an audited
 * owned collection each moved record is recorded as `store.record.reassigned`; on an audited membership collection
 * the change is recorded as `from` removed and (unless it already was a member) `to` added.
 */
export async function reassignOwner(database: string, options: ReassignOptions): Promise<ReassignReport> {
  const { from, to } = options;
  if (typeof from !== 'string' || !principalIdPattern.test(from)) throw new Error(principalMessage('--from'));
  if (typeof to !== 'string' || !principalIdPattern.test(to)) throw new Error(principalMessage('--to'));
  if (from === to) throw new Error('--from and --to name the same principal');
  const actor = operatorActor(options.actor);
  if (!options.collections || typeof options.collections !== 'object') throw new Error('The project declares no store collections');
  const touched: { name: string; spec: NormalizedSpec }[] = Object.entries(options.collections).map(([name, spec]) => ({ name, spec: normalize(name, spec) })).filter(entry => entry.spec.ownership === 'owner' || entry.spec.membership);
  let selected = touched;
  if (options.collection !== undefined) {
    if (!Object.hasOwn(options.collections, options.collection)) throw new Error(`Collection ${options.collection} is not declared`);
    selected = touched.filter(entry => entry.name === options.collection);
    if (!selected.length) throw new Error(`Collection ${options.collection} is not declared with ownership: owner or membership: true`);
  }
  if (!selected.length) throw new Error('The project declares no collection with ownership: owner or membership: true');
  const lists = selected.filter(entry => entry.spec.membership);
  const audited = selected.find(entry => entry.spec.audit);
  const validate = audited ? await auditValidator(audited.name) : undefined;
  const specOf = (name: string) => selected.find(entry => entry.name === name)!.spec;
  return transaction(database, db => {
    const member = (collection: string, principal: string) => db.get<{ id: string; updated_at: string }>('SELECT id, updated_at FROM store_records WHERE collection = ? AND key = ?', collection, principal);
    const memberships: ReassignMembershipReport[] = lists.filter(({ name }) => member(name, from) !== undefined).map(({ name }) => ({ collection: name, toWasMember: member(name, to) !== undefined }));
    const count = (collection: string, owner: string) => db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', collection, owner)!.n;
    // A declared collection that holds no records yet has nothing to move and is left out of the report.
    const collections: ReassignCollectionReport[] = selected.filter(({ name, spec }) => spec.ownership === 'owner' && total(db, name) > 0).map(({ name, spec }) => {
      const moved = count(name, from), toBefore = count(name, to);
      return { collection: name, moved, toBefore, toAfter: toBefore + moved, maxRecordsPerOwner: spec.maxRecordsPerOwner ?? null };
    });
    const over = collections.filter(report => report.moved > 0 && report.maxRecordsPerOwner !== null && report.toAfter > report.maxRecordsPerOwner);
    if (over.length) throw new Error(`Nothing was moved: ${over.map(report => `collection ${report.collection} would give ${to} ${report.toAfter} records, over its maxRecordsPerOwner of ${report.maxRecordsPerOwner}`).join('; ')}. Delete or reassign some of its records first, or raise the limit.`);
    // Every audit event the move records, per collection, is counted before anything is written.
    const planned = new Map<string, number>();
    for (const report of collections) if (specOf(report.collection).audit) planned.set(report.collection, report.moved);
    for (const report of memberships) if (specOf(report.collection).audit) planned.set(report.collection, report.toWasMember ? 1 : 2);
    assertBacklog(db, planned);
    const auditEvents = [...planned.values()].reduce((sum, events) => sum + events, 0);
    const report = { from, to, dryRun: options.dryRun === true, moved: collections.reduce((sum, item) => sum + item.moved, 0), auditEvents, collections, memberships };
    if (options.dryRun) return report;
    // Membership: `from`'s entry becomes `to`'s (the key column and the key field together), or goes when `to` already
    // has one. A membership list has no per-owner limit and never grows here.
    for (const item of memberships) {
      const spec = specOf(item.collection), row = member(item.collection, from)!;
      if (item.toWasMember) db.run('DELETE FROM store_records WHERE collection = ? AND id = ?', item.collection, row.id);
      else db.run('UPDATE store_records SET key = ?, updated_at = ?, data = json_set(data, ?, ?) WHERE collection = ? AND id = ?', to, stamp(row.updated_at), `$.${spec.key!}`, to, item.collection, row.id);
      if (spec.audit) {
        writeAuditEvent(db, item.collection, validate!, membershipEvent(item.collection, 'removed', from, actor));
        if (!item.toWasMember) writeAuditEvent(db, item.collection, validate!, membershipEvent(item.collection, 'added', to, actor));
      }
    }
    for (const item of collections) {
      if (!item.moved) continue;
      const ids = specOf(item.collection).audit ? ownedIds(db, item.collection, from) : [];
      db.run('UPDATE store_records SET owner = ? WHERE collection = ? AND owner = ?', to, item.collection, from);
      for (const id of ids) writeAuditEvent(db, item.collection, validate!, reassignedEvent(item.collection, id, from, to, actor));
    }
    const recorded = [...planned].filter(([, events]) => events > 0).map(([collection]) => collection);
    return recorded.length ? { ...report, ...auditDelivery(db, recorded, Date.now()) } : report;
  });
}
