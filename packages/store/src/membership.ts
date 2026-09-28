/**
 * The operator path for membership collections (#863): `membership: true` collections have no mount, so nobody can
 * add themselves over HTTP. The operator adds and removes members here (trusted extension code can also use
 * `StoreExports`). Each call is one SQLite transaction on its own connection to the store database, so it may run
 * while the server is serving; the server reads membership inside every gated request's own transaction, so a
 * change applies to the next request. Like `reassignOwner`, it takes the project's declared collections, and it
 * writes through the collection's own validation (the key must be a principal id; `maxRecords` applies).
 */
import { isAbsolute } from 'node:path';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { Collection, StoreError } from './collection.ts';
import type { CollectionSpec } from './collection.ts';
import { openStoreDatabase } from './database.ts';

export interface MembershipOptions {
  /** The project's declared store collections (`extensions.store.config.collections`). */
  collections: Record<string, CollectionSpec>;
  /** A declared collection with `membership: true`. */
  collection: string;
}
export interface MemberOptions extends MembershipOptions {
  /** The member's principal id, exactly as the principal provider sets it (for auth, the Better Auth user id). */
  principal: string;
}
export interface MemberReport { collection: string; principal: string; changed: boolean }

function membershipCollection(options: MembershipOptions): Collection {
  if (!options?.collections || typeof options.collections !== 'object') throw new Error('The project declares no store collections');
  if (typeof options.collection !== 'string' || !Object.hasOwn(options.collections, options.collection)) throw new Error(`Collection ${String(options.collection).slice(0, 64)} is not declared`);
  const collection = new Collection(options.collection, options.collections[options.collection]!);
  if (!collection.spec.membership) throw new Error(`Collection ${options.collection} is not a membership collection (membership: true)`);
  return collection;
}
/** Opens the store database (creating it when `create`), validates the collection's stored rows and runs `work`. */
async function withCollection<T>(database: string, options: MembershipOptions, create: boolean, work: (collection: Collection) => T): Promise<T> {
  if (typeof database !== 'string' || !isAbsolute(database)) throw new Error('Store database must be an absolute path');
  const collection = membershipCollection(options);
  const db = await openStoreDatabase(database, { create });
  try { collection.open(db); return work(collection); } finally { collection.close(); db.close(); }
}
const principalOf = (principal: string): string => {
  if (typeof principal !== 'string' || !principalIdPattern.test(principal)) throw new Error('The member must be a principal id: 1 to 128 ASCII letters, digits, ".", "_", ":" or "-", starting with a letter or digit');
  return principal;
};

/** Adds `principal` to the membership collection; `changed` is false when it was already a member. Creates the database when absent. */
export async function addMember(database: string, options: MemberOptions): Promise<MemberReport> {
  const principal = principalOf(options.principal);
  return withCollection(database, options, true, collection => {
    try { collection.create({ [collection.spec.key!]: principal }, undefined, undefined, 'operator'); }
    catch (error) { if (error instanceof StoreError && error.code === 'key_exists') return { collection: collection.name, principal, changed: false }; throw error; }
    return { collection: collection.name, principal, changed: true };
  });
}
/** Removes `principal` from the membership collection; `changed` is false when it was not a member. */
export async function removeMember(database: string, options: MemberOptions): Promise<MemberReport> {
  const principal = principalOf(options.principal);
  return withCollection(database, options, false, collection => {
    let id: string;
    try { id = collection.getByKey(principal).id as string; } catch (error) { if (error instanceof StoreError && error.status === 404) return { collection: collection.name, principal, changed: false }; throw error; }
    try { collection.remove(id, undefined, undefined, undefined, 'operator'); } catch (error) { if (error instanceof StoreError && error.status === 404) return { collection: collection.name, principal, changed: false }; throw error; }
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
