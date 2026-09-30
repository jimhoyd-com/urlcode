/**
 * `reassignOwner` (urlcode#732), the operator step that moves every record one principal owns to another (a revoked
 * or rotated API key's `apikey:<id>` to its replacement or to a user), and the principal's membership in every
 * membership collection with them (#866). It needs the declared collections to know which are owned or
 * membership lists and each one's `maxRecordsPerOwner`, and is refused as a whole rather than leaving any principal
 * over its limit. It is one SQLite transaction on its own connection to the store database, so it is safe to run
 * while the server is serving: the server reads the database on every request and sees the change on its next one.
 *
 * Audit (#875): on a collection declared `audit: true`, every record it moves writes one event into the store's audit
 * log in the same transaction, with the actor `operator` or the operator's `--actor` (operator-asserted, not
 * authenticated): `store.record.reassigned` (subject `<collection>/<id>`, metadata `{collection, from, to}`, the opaque
 * principal ids as membership events carry them). The count is known before anything is written, so a move that would
 * record more events than `auditRetention` keeps (and so prune its own) is refused whole, a dry run included.
 */
import { isAbsolute } from 'node:path';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { declarationFingerprint, membershipEvent, normalize, operatorFence, overlapping, stamp } from './collection.ts';
import type { CollectionSpec, NormalizedSpec } from './collection.ts';
import { AUDIT_RETENTION, recordAuditEvent } from './audit.ts';
import { operatorActor } from './membership.ts';
import { openStoreDatabase } from './database.ts';
import type { StoreDatabase } from './database.ts';

/** Opens an existing store database (never creates one), runs `work` in one write transaction and closes it. */
async function transaction<T>(database: string, work: (db: StoreDatabase) => T): Promise<T> {
  if (typeof database !== 'string' || !isAbsolute(database)) throw new Error('Store database must be an absolute path');
  const db = await openStoreDatabase(database, { create: false });
  try { return db.transaction(() => work(db)); } finally { db.close(); }
}
const total = (db: StoreDatabase, collection: string): number => db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ?', collection)!.n;
const ownedIds = (db: StoreDatabase, collection: string, owner: string): string[] => db.all<{ id: string }>('SELECT id FROM store_records WHERE collection = ? AND owner = ? ORDER BY seq', collection, owner).map(row => row.id);

/**
 * Refuses, before anything is written, giving `from`'s records to `to` on a collection whose `intervals` constrain
 * each owner's records (`scope: owner`) when that would leave `to` holding two overlapping intervals (#902). A `scope: collection` constraint does not depend on the owner, so a move keeps it.
 */
function refuseOverlap(db: StoreDatabase, collection: string, spec: NormalizedSpec, from: string, to: string): void {
  if (spec.intervals?.scope !== 'owner') return;
  const pair = overlapping(db, spec.intervals, { from, to });
  if (pair) throw new Error(`Nothing was moved: collection ${collection} would give ${to} records ${pair[0]} and ${pair[1]}, whose intervals overlap, which its intervals refuse. Move or delete one of them first.`);
}
const reassignedEvent = (collection: string, id: string, from: string, to: string, actor: string) =>
  ({ action: 'store.record.reassigned', actor, subject: `${collection}/${id}`, metadata: { collection, from, to } });

const principalMessage = (flag: string) => `${flag} must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit`;
export interface ReassignCollectionReport { collection: string; moved: number; toBefore: number; toAfter: number; maxRecordsPerOwner: number | null }
/**
 * One membership collection `from` belonged to: its membership moves to `to`, or, when `to` already was a member
 * (`toWasMember`), `from`'s entry is just removed.
 */
export interface ReassignMembershipReport { collection: string; toWasMember: boolean }
/**
 * `auditEvents`: how many audit events the move records (or, on a dry run, would record) across the audited collections.
 */
export interface ReassignReport { from: string; to: string; dryRun: boolean; moved: number; auditEvents: number; collections: ReassignCollectionReport[]; memberships: ReassignMembershipReport[] }
export interface ReassignOptions {
  /** The principal id the records belong to now, exactly as stored (`apikey:<key id>`, a user id, ...). */
  from: string;
  /** The principal id they move to. */
  to: string;
  /** The project's declared store collections (`extensions.store.config.collections`); only `ownership: owner` and `membership: true` ones are touched. */
  collections: Record<string, CollectionSpec>;
  /** The project's named schemas (`loadDocument(project).schemas`), which a collection's `schema: <name>` resolves against. */
  schemas?: Readonly<Record<string, unknown>>;
  /** Limit the move to one owned or membership collection. */
  collection?: string;
  /** Report what would move and change nothing. */
  dryRun?: boolean;
  /** The audit actor recorded on `audit: true` collections (a principal id; default `operator`). Operator-asserted, not authenticated. */
  actor?: string;
  /** The project's `auditRetention` (default 100000): the audit log is pruned to it after the move's events. */
  auditRetention?: number;
}

/**
 * Moves every record owned by `from` to `to` in the owned collections (or the one named), and `from`'s membership in
 * the membership collections, in one transaction. Counts are computed for every affected collection first; when any
 * move would leave `to` holding more than that collection's `maxRecordsPerOwner`, or would record more audit events
 * than `auditRetention` keeps, the whole operation is refused, naming the collection, and nothing is written.
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
  const touched: { name: string; spec: NormalizedSpec }[] = Object.entries(options.collections).map(([name, spec]) => ({ name, spec: normalize(name, spec, options.schemas) })).filter(entry => entry.spec.ownership === 'owner' || entry.spec.membership);
  let selected = touched;
  if (options.collection !== undefined) {
    if (!Object.hasOwn(options.collections, options.collection)) throw new Error(`Collection ${options.collection} is not declared`);
    selected = touched.filter(entry => entry.name === options.collection);
    if (!selected.length) throw new Error(`Collection ${options.collection} is not declared with ownership: owner or membership: true`);
  }
  if (!selected.length) throw new Error('The project declares no collection with ownership: owner or membership: true');
  const lists = selected.filter(entry => entry.spec.membership);
  const retention = options.auditRetention ?? AUDIT_RETENTION.default;
  const specOf = (name: string) => selected.find(entry => entry.name === name)!.spec;
  return transaction(database, db => {
    for (const { name, spec } of selected) operatorFence(db, name, declarationFingerprint(spec));
    const member = (collection: string, principal: string) => db.get<{ id: string; updated_at: string }>('SELECT id, updated_at FROM store_records WHERE collection = ? AND key = ?', collection, principal);
    const memberships: ReassignMembershipReport[] = lists.filter(({ name }) => member(name, from) !== undefined).map(({ name }) => ({ collection: name, toWasMember: member(name, to) !== undefined }));
    const count = (collection: string, owner: string) => db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', collection, owner)!.n;
    // A declared collection that holds no records yet has nothing to move and is left out of the report.
    const collections: ReassignCollectionReport[] = selected.filter(({ name, spec }) => spec.ownership === 'owner' && total(db, name) > 0).map(({ name, spec }) => {
      const moved = count(name, from), toBefore = count(name, to);
      return { collection: name, moved, toBefore, toAfter: toBefore + moved, maxRecordsPerOwner: spec.maxRecordsPerOwner ?? null };
    });
    const over = collections.filter(report => report.moved > 0 && report.maxRecordsPerOwner !== null && report.toAfter > report.maxRecordsPerOwner);
    for (const report of collections) if (report.moved > 0) refuseOverlap(db, report.collection, specOf(report.collection), from, to);
    if (over.length) throw new Error(`Nothing was moved: ${over.map(report => `collection ${report.collection} would give ${to} ${report.toAfter} records, over its maxRecordsPerOwner of ${report.maxRecordsPerOwner}`).join('; ')}. Delete or reassign some of its records first, or raise the limit.`);
    // Every audit event the move records, per collection, is counted before anything is written.
    const planned = new Map<string, number>();
    for (const report of collections) if (specOf(report.collection).audit) planned.set(report.collection, report.moved);
    for (const report of memberships) if (specOf(report.collection).audit) planned.set(report.collection, report.toWasMember ? 1 : 2);
    const auditEvents = [...planned.values()].reduce((sum, events) => sum + events, 0);
    if (auditEvents > retention) throw new Error(`Nothing was moved: the move would record ${auditEvents} audit events, more than the audit log keeps (auditRetention ${retention}), so it would prune its own. Move fewer records at a time (--collection), or raise auditRetention.`);
    const report = { from, to, dryRun: options.dryRun === true, moved: collections.reduce((sum, item) => sum + item.moved, 0), auditEvents, collections, memberships };
    if (options.dryRun) return report;
    // Membership: `from`'s entry becomes `to`'s (the key column and the key field together), or goes when `to` already
    // has one. A membership list has no per-owner limit and never grows here.
    for (const item of memberships) {
      const spec = specOf(item.collection), row = member(item.collection, from)!;
      if (item.toWasMember) db.run('DELETE FROM store_records WHERE collection = ? AND id = ?', item.collection, row.id);
      else db.run('UPDATE store_records SET key = ?, updated_at = ?, data = json_set(data, ?, ?) WHERE collection = ? AND id = ?', to, stamp(row.updated_at), `$.${spec.key!}`, to, item.collection, row.id);
      if (spec.audit) {
        recordAuditEvent(db, membershipEvent(item.collection, 'removed', from, actor), retention);
        if (!item.toWasMember) recordAuditEvent(db, membershipEvent(item.collection, 'added', to, actor), retention);
      }
    }
    for (const item of collections) {
      if (!item.moved) continue;
      const ids = specOf(item.collection).audit ? ownedIds(db, item.collection, from) : [];
      db.run('UPDATE store_records SET owner = ? WHERE collection = ? AND owner = ?', to, item.collection, from);
      for (const id of ids) recordAuditEvent(db, reassignedEvent(item.collection, id, from, to, actor), retention);
    }
    return report;
  });
}
