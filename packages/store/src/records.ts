/**
 * The store's typed export (#529): what an extension that `requires: [store]` reads through `ctx.get('store')`.
 * It reaches the collections the project declared under the store's own configuration by name, never by reading
 * that configuration, and applies exactly the rules the HTTP API applies: per-record ownership (the caller passes
 * the request principal; an owned collection answers another owner's record as the same 404 as a missing one),
 * record schema validation, `maxRecords`, `maxRecordBytes`, `readOnly` and strong ETags with a 412 on a stale `ifMatch`.
 * Failures are `StoreError`s carrying the same status, code and field names the HTTP API returns.
 *
 * `transaction(work)` (#835) runs several of those operations, across the declared collections, as one database
 * transaction: trusted host code only (never sandboxed, never a route function), synchronous, one database.
 */
import type { ExtensionPrincipal } from '@jimhoyd/urlcode/extensions';
import { OWNER_FIELD, StoreError, etagOf, storageFailure } from './collection.ts';
import type { Collection, Ownership, RecordSchema, Scalar, Step, StoredRecord } from './collection.ts';
import type { StoreDatabase } from './database.ts';

/** Export contract version 1. */
export interface StoreExports {
  readonly version: 1;
  /** Whether the runtime has activated the store; `records` refuses until it has. */
  readonly active: boolean;
  /** One declared collection. Throws an `Error` when the store is not active or declares no such collection. */
  records(collection: string): StoreRecords;
  /**
   * Runs `work` as one `BEGIN IMMEDIATE` transaction of the store database and returns what it returns: every write it
   * makes through `tx.records(name)`, in any declared collections, and their audit events commit together, or none
   * does. A throw from `work` (a `StoreError` such as a 412 or 409, or the caller's own error) rolls everything back
   * and is rethrown; a SQLite failure is a 503 `StoreError`. `work` must be synchronous: a returned promise is refused
   * and rolled back, and `tx` refuses every call once `work` has returned. Transactions do not nest, and calling
   * `records()` inside `work` is refused because it would open a second one. Trusted host code only: this is not a
   * sandbox, `work` runs with full Node access, and the principals it passes are taken as given.
   */
  transaction<T>(work: (tx: StoreTransaction) => T): T;
}
/** The operations of one host transaction (`StoreExports.transaction`). */
export interface StoreTransaction {
  /** One declared collection, inside this transaction. Throws an `Error` for an undeclared one. */
  records(collection: string): StoreTransactionRecords;
}
/** The same operations and rules as `StoreRecords`, synchronous, inside the surrounding transaction. */
export interface StoreTransactionRecords {
  readonly name: string;
  create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>): StoreRecordResult;
  get(principal: StorePrincipal, id: string): StoreRecordResult;
  update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar | null>>, options?: { ifMatch?: string }): StoreRecordResult;
  remove(principal: StorePrincipal, id: string, options?: { ifMatch?: string }): void;
  /** Runs a declared transition, exactly as its HTTP endpoint does (without an `Idempotency-Key`). */
  transition(principal: StorePrincipal, id: string, name: string, options?: { ifMatch?: string }): StoreRecordResult;
  list(principal: StorePrincipal, options?: { limit?: number; cursor?: string }): StoreListResult;
}
/** A record as a caller sees it (never its stored owner) and its strong ETag. */
export interface StoreRecordResult { readonly record: Readonly<StoredRecord>; readonly etag: string }
/** The principal of the request being served (`request.principal`); `null`/`undefined` when it has none. */
export type StorePrincipal = Pick<ExtensionPrincipal, 'id'> | null | undefined;
export interface StoreRecords {
  readonly name: string;
  readonly ownership: Ownership;
  readonly readOnly: boolean;
  /** The declared record schema (a deep-frozen copy), so a consumer can check its own mapping at activation. */
  readonly schema: Readonly<RecordSchema>;
  /** Creates a record, stamping the principal as its owner on an owned collection. */
  create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>): Promise<StoreRecordResult>;
  /** One record in the principal's scope. */
  get(principal: StorePrincipal, id: string): StoreRecordResult;
  /**
   * A partial update (the HTTP API's PATCH): only the supplied properties change, and one set to `null` is removed.
   * The result must satisfy the collection schema (a cleared required property is a 422 `invalid_record` issue), and
   * an increment property cannot be cleared. With `ifMatch`, a record changed since that ETag is refused with 412.
   */
  update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar | null>>, options?: { ifMatch?: string }): Promise<StoreRecordResult>;
  /**
   * One page of the principal's scope (the HTTP API's unsorted `GET` list, in creation order): on an owned collection
   * only the principal's own records, and `total` counts only those. `limit` is capped at the collection's
   * `pageSize`. `cursor` is a `next` or `previous` value an earlier page returned; anything else is a 400.
   */
  list(principal: StorePrincipal, options?: { limit?: number; cursor?: string }): StoreListResult;
  /** Runs the declared transition `name` on one record in its own transaction (its HTTP endpoint without an `Idempotency-Key`). */
  transition(principal: StorePrincipal, id: string, name: string, options?: { ifMatch?: string }): Promise<StoreRecordResult>;
}
/** One list page. `next` and `previous` are the cursors of the adjacent pages, absent at either end. */
export interface StoreListResult { readonly items: readonly Readonly<StoredRecord>[]; readonly total: number; readonly next?: string; readonly previous?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const view = (record: StoredRecord): Readonly<StoredRecord> => { const { [OWNER_FIELD]: _owner, ...rest } = record; return Object.freeze(rest); };
const result = (record: StoredRecord): StoreRecordResult => Object.freeze({ record: view(record), etag: etagOf(record) });
const ownerOf = (principal: StorePrincipal): string | undefined => principal === null || principal === undefined ? undefined : principal.id;
/** The audit actor of a write: the principal's id, or `anonymous` (the HTTP API's rule). */
const actorOf = (principal: StorePrincipal): string => ownerOf(principal) ?? 'anonymous';
const known = (id: string): string => { if (typeof id !== 'string' || !UUID.test(id)) throw new StoreError(404, 'not_found', 'No such record'); return id; };
const matchOf = (options: { ifMatch?: string }): string | undefined => {
  if (options.ifMatch !== undefined && (typeof options.ifMatch !== 'string' || !/^"[0-9a-f]{32}"$/.test(options.ifMatch))) throw new StoreError(400, 'invalid_if_match', 'If-Match must be one strong quoted ETag this store issued');
  return options.ifMatch;
};
/** The list parameters the export accepts: an unsorted page, whose cursor is the offset into creation order. */
function pageParams(options: { limit?: number; cursor?: string }): URLSearchParams {
  const invalid = (field: string, message: string) => new StoreError(400, 'invalid_query', 'The query is not valid', { fields: { [field]: message } });
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw invalid('limit', 'must be a positive integer');
  if (options.cursor !== undefined && typeof options.cursor !== 'string') throw invalid('cursor', 'must be a cursor this store issued');
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  return params;
}
function pageOf(collection: Collection, options: { limit?: number; cursor?: string }, page: { items: StoredRecord[]; total: number; next?: string | number }): StoreListResult {
  const limit = Math.min(options.limit ?? collection.spec.pageSize, collection.spec.pageSize), offset = options.cursor === undefined ? 0 : Number(options.cursor);
  return Object.freeze({
    items: Object.freeze(page.items.map(view)), total: page.total,
    ...(page.next === undefined ? {} : { next: String(page.next) }),
    ...(offset > 0 ? { previous: String(Math.max(0, offset - limit)) } : {}),
  });
}

/**
 * One host transaction over the activation's collections. Every operation is a write step from collection.ts run on
 * the one open database; audited collections are woken after the commit. `open` turns false when `work` returns, so a
 * handle kept past the transaction (for example across an `await`) refuses instead of writing outside it.
 */
function runTransaction<T>(byName: Map<string, Collection>, work: (tx: StoreTransaction) => T): T {
  if (typeof work !== 'function') throw new TypeError('transaction needs a synchronous function');
  const first = byName.values().next().value as Collection | undefined;
  if (!first) throw new Error('store declares no collections');
  const db: StoreDatabase = first.database();
  const audited = new Set<Collection>();
  let open = true;
  const live = (): void => { if (!open) throw new Error('This store transaction has ended; use tx only inside the transaction function'); };
  const step = (collection: Collection, done: Step): StoredRecord | undefined => { if (done.audited) audited.add(collection); return done.record; };
  const handles = new Map<string, StoreTransactionRecords>();
  const tx: StoreTransaction = Object.freeze({
    records(name: string): StoreTransactionRecords {
      live();
      const collection = typeof name === 'string' ? byName.get(name) : undefined;
      if (!collection) throw new Error(`store declares no collection ${String(name).slice(0, 64)}`);
      let handle = handles.get(name);
      if (!handle) {
        handle = Object.freeze({
          name,
          create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>) { live(); return result(step(collection, collection.createFor(db, { ...values }, ownerOf(principal), actorOf(principal)))!); },
          get(principal: StorePrincipal, id: string) { live(); return result(collection.getIn(db, known(id), ownerOf(principal))); },
          update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar | null>>, options: { ifMatch?: string } = {}) { live(); return result(step(collection, collection.updateFor(db, known(id), { ...patch }, matchOf(options), ownerOf(principal), actorOf(principal)))!); },
          remove(principal: StorePrincipal, id: string, options: { ifMatch?: string } = {}) { live(); step(collection, collection.removeFor(db, known(id), matchOf(options), ownerOf(principal), actorOf(principal))); },
          transition(principal: StorePrincipal, id: string, transition: string, options: { ifMatch?: string } = {}) { live(); return result(step(collection, collection.transitionIn(db, known(id), String(transition), matchOf(options), ownerOf(principal), actorOf(principal)))!); },
          list(principal: StorePrincipal, options: { limit?: number; cursor?: string } = {}) { live(); return pageOf(collection, options, collection.listPageIn(db, pageParams(options), ownerOf(principal))); },
        });
        handles.set(name, handle);
      }
      return handle;
    },
  });
  let value: T;
  try {
    value = db.transaction(() => {
      try {
        const returned = work(tx);
        if (returned !== null && typeof returned === 'object' && typeof (returned as { then?: unknown }).then === 'function') throw new TypeError('A store transaction function must be synchronous: it returned a promise, so nothing it did was committed');
        return returned;
      } finally { open = false; }
    });
  } catch (error) { return storageFailure(error, true); }
  for (const collection of audited) collection.notifyAudit();
  return value;
}

function records(collection: Collection): StoreRecords {
  return Object.freeze({
    name: collection.name, ownership: collection.spec.ownership, readOnly: collection.spec.readOnly, schema: collection.spec.records.schema,
    async create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>) { return result(collection.create({ ...values }, undefined, ownerOf(principal), actorOf(principal)).record!); },
    get(principal: StorePrincipal, id: string) { return result(collection.get(known(id), ownerOf(principal))); },
    async update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar | null>>, options: { ifMatch?: string } = {}) {
      return result(collection.update(known(id), { ...patch }, false, undefined, matchOf(options), ownerOf(principal), actorOf(principal)).record!);
    },
    list(principal: StorePrincipal, options: { limit?: number; cursor?: string } = {}) {
      // The same parser and scoping as the HTTP list.
      return pageOf(collection, options, collection.list(pageParams(options), ownerOf(principal)));
    },
    async transition(principal: StorePrincipal, id: string, name: string, options: { ifMatch?: string } = {}) {
      return result(collection.transition(known(id), String(name), undefined, matchOf(options), ownerOf(principal), actorOf(principal)).record!);
    },
  });
}

/**
 * The export object and the two calls the registration makes: `attach` when an activation has loaded its
 * collections, and `detach` (with the token `attach` returned) when that activation closes. The newest live
 * activation is the one served: a newer activation's collections are never detached by an older one's close, and
 * when a failed reload closes the newest, the activation still serving is current again (RIM-EXT-HANDOFF-001).
 */
export function storeExports(): { exports: StoreExports; attach(collections: readonly Collection[]): symbol; detach(token: symbol): void } {
  type Attached = { token: symbol; byName: Map<string, StoreRecords>; collections: Map<string, Collection> };
  const attached: Attached[] = [];
  let current: Attached | undefined;
  const exports: StoreExports = Object.freeze({
    version: 1 as const,
    get active() { return current !== undefined; },
    records(name: string): StoreRecords {
      if (!current) throw new Error('store is not active yet: the runtime activates store before the extensions that require it, so call records() from activate or a request, not from host()');
      const found = typeof name === 'string' ? current.byName.get(name) : undefined;
      if (!found) throw new Error(`store declares no collection ${String(name).slice(0, 64)}`);
      return found;
    },
    transaction<T>(work: (tx: StoreTransaction) => T): T {
      if (!current) throw new Error('store is not active yet: run transactions from activate or a request, not from host()');
      return runTransaction(current.collections, work);
    },
  });
  return {
    exports,
    attach(collections) { const token = Symbol('store activation'); current = { token, byName: new Map(collections.map(collection => [collection.name, records(collection)])), collections: new Map(collections.map(collection => [collection.name, collection])) }; attached.push(current); return token; },
    detach(token) { const index = attached.findIndex(entry => entry.token === token); if (index >= 0) attached.splice(index, 1); current = attached.at(-1); },
  };
}
