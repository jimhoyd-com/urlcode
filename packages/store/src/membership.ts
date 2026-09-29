/**
 * The operator path for membership collections (#863): `membership: true` collections have no mount, so nobody can
 * add themselves over HTTP. The operator adds and removes members here (`urlcode-store members`; trusted extension
 * code can also use `StoreExports`). Each call is one SQLite transaction on its own connection to the store database,
 * so it may run while the server is serving; the server reads membership inside every gated request's own
 * transaction, so a change applies to the next request. Like `reassignOwner`, it takes the project's declared
 * collections, and it writes through the collection's own validation (the key must be a principal id; `maxRecords`
 * applies).
 *
 * On a collection declared `audit: true` (#866) each added or removed member also inserts its
 * `store.membership.added`/`removed` event into the outbox in the same transaction, validated by audit's own pure
 * validator, with the actor `operator` or the operator's `--actor`. The serving process's audit drain picks it up on its
 * next poll. The report then carries `undeliveredEvents`, `lastAuditDrain` and, when events wait and no drain has kept
 * up recently, a `warning` (database.ts `auditDelivery`).
 */
import { isAbsolute } from 'node:path';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import type { AuditEvent } from '@jimhoyd/urlcode-audit';
import { Collection, StoreError } from './collection.ts';
import type { CollectionAuditor, CollectionSpec } from './collection.ts';
import { auditDelivery, openStoreDatabase } from './database.ts';
import type { AuditDelivery } from './database.ts';

/** The actor of a change made through the operator path when the operator names none (`--actor`). */
export const OPERATOR_ACTOR = 'operator';
/**
 * The audit actor for an operator change (#875): `actor` when given, else `operator`. It must be a principal id, like
 * every other actor the store records. It is operator-asserted, never authenticated: whoever can run the CLI against
 * the database can write any id here, so it attributes a change without proving who made it.
 */
export function operatorActor(actor: string | undefined): string {
  if (actor === undefined) return OPERATOR_ACTOR;
  if (typeof actor !== 'string' || !principalIdPattern.test(actor)) throw new Error('--actor must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit');
  return actor;
}
/**
 * Audit's pure event validator, for an operator command that writes events into the outbox itself (no audit instance
 * runs in the CLI). Loaded only when a collection it touches declares `audit: true`; audit is an optional peer.
 */
export async function auditValidator(collection: string): Promise<(value: unknown) => AuditEvent> {
  try { return (await import('@jimhoyd/urlcode-audit')).validateAuditEvent; }
  catch { throw new Error(`Collection ${collection} declares audit: true, but the audit package is not installed beside the store; install it (urlcode extensions add audit) so the change can be recorded`); }
}

export interface MembershipOptions {
  /** The project's declared store collections (`extensions.store.config.collections`). */
  collections: Record<string, CollectionSpec>;
  /** A declared collection with `membership: true`. */
  collection: string;
  /** The audit actor recorded for the change (a principal id; default `operator`). Operator-asserted, not authenticated. */
  actor?: string;
}
export interface MemberOptions extends MembershipOptions {
  /** The member's principal id, exactly as the principal provider sets it (for auth, the Better Auth user id). */
  principal: string;
}
/** On an `audit: true` collection it also carries the outbox delivery status (`AuditDelivery`). */
export type MemberReport = { collection: string; principal: string; changed: boolean } & Partial<AuditDelivery>;

async function membershipCollection(options: MembershipOptions): Promise<Collection> {
  if (!options?.collections || typeof options.collections !== 'object') throw new Error('The project declares no store collections');
  if (typeof options.collection !== 'string' || !Object.hasOwn(options.collections, options.collection)) throw new Error(`Collection ${String(options.collection).slice(0, 64)} is not declared`);
  const spec = options.collections[options.collection]!;
  if (spec?.membership !== true) throw new Error(`Collection ${options.collection} is not a membership collection (membership: true)`);
  // No drain runs here to wake: the serving process's drain polls the outbox.
  const auditor: CollectionAuditor | undefined = spec.audit === true ? { validate: await auditValidator(options.collection), notify() {} } : undefined;
  return new Collection(options.collection, spec, auditor);
}
/** Opens the store database (creating it when `create`), validates the collection's stored rows and runs `work`. */
async function withCollection<T>(database: string, options: MembershipOptions, create: boolean, work: (collection: Collection) => T): Promise<T> {
  if (typeof database !== 'string' || !isAbsolute(database)) throw new Error('Store database must be an absolute path');
  const collection = await membershipCollection(options);
  const db = await openStoreDatabase(database, { create });
  try {
    collection.open(db);
    const result = work(collection);
    // A command that changed an audited membership reports whether its events are being delivered (#875).
    return collection.spec.audit && result && typeof result === 'object' && 'changed' in result ? { ...result, ...auditDelivery(db, [collection.name], Date.now()) } as T : result;
  } finally { collection.close(); db.close(); }
}
const principalOf = (principal: string): string => {
  if (typeof principal !== 'string' || !principalIdPattern.test(principal)) throw new Error('The member must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit');
  return principal;
};

/** Adds `principal` to the membership collection; `changed` is false when it was already a member. Creates the database when absent. */
export async function addMember(database: string, options: MemberOptions): Promise<MemberReport> {
  const principal = principalOf(options.principal), actor = operatorActor(options.actor);
  return withCollection(database, options, true, collection => {
    try { collection.create({ [collection.spec.key!]: principal }, undefined, undefined, actor); }
    catch (error) { if (error instanceof StoreError && error.code === 'key_exists') return { collection: collection.name, principal, changed: false }; throw error; }
    return { collection: collection.name, principal, changed: true };
  });
}
/** Removes `principal` from the membership collection; `changed` is false when it was not a member. */
export async function removeMember(database: string, options: MemberOptions): Promise<MemberReport> {
  const principal = principalOf(options.principal), actor = operatorActor(options.actor);
  return withCollection(database, options, false, collection => {
    let id: string;
    try { id = collection.getByKey(principal).id as string; } catch (error) { if (error instanceof StoreError && error.status === 404) return { collection: collection.name, principal, changed: false }; throw error; }
    try { collection.remove(id, undefined, undefined, undefined, actor); } catch (error) { if (error instanceof StoreError && error.status === 404) return { collection: collection.name, principal, changed: false }; throw error; }
    return { collection: collection.name, principal, changed: true };
  });
}
/** Every member's principal id, in the order they were added. Changes nothing. */
export async function listMembers(database: string, options: MembershipOptions): Promise<{ collection: string; members: string[] }> {
  return withCollection(database, options, false, collection => {
    const members: string[] = [];
    for (let cursor: string | number | undefined = 0; cursor !== undefined;) {
      const page: { items: Record<string, unknown>[]; next?: string | number } = collection.list(new URLSearchParams({ cursor: String(cursor), limit: String(collection.spec.pageSize) }));
      members.push(...page.items.map(item => item[collection.spec.key!] as string));
      cursor = page.next;
    }
    return { collection: collection.name, members };
  });
}
