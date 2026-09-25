/**
 * The store's typed export (#529): what an extension that `requires: [store]` reads through `ctx.get('store')`.
 * It reaches the collections the project declared under the store's own configuration by name, never by reading
 * that configuration, and applies exactly the rules the HTTP API applies: per-record ownership (the caller passes
 * the request principal; an owned collection answers another owner's record as the same 404 as a missing one),
 * field validation, `maxRecords`, `maxRecordBytes`, `readOnly` and strong ETags with a 412 on a stale `ifMatch`.
 * Failures are `StoreError`s carrying the same status, code and field names the HTTP API returns.
 */
import type { ExtensionPrincipal } from '@jimhoyd/urlcode/extensions';
import { OWNER_FIELD, StoreError, etagOf } from './collection.ts';
import type { Collection, FieldSpec, Ownership, Scalar, StoredRecord } from './collection.ts';

/** Export contract version 1. */
export interface StoreExports {
  readonly version: 1;
  /** Whether the runtime has activated the store; `records` refuses until it has. */
  readonly active: boolean;
  /** One declared collection. Throws an `Error` when the store is not active or declares no such collection. */
  records(collection: string): StoreRecords;
}
/** A record as a caller sees it (never its stored owner) and its strong ETag. */
export interface StoreRecordResult { readonly record: Readonly<StoredRecord>; readonly etag: string }
/** The principal of the request being served (`request.principal`); `null`/`undefined` when it has none. */
export type StorePrincipal = Pick<ExtensionPrincipal, 'id'> | null | undefined;
export interface StoreRecords {
  readonly name: string;
  readonly ownership: Ownership;
  readonly readOnly: boolean;
  /** The declared fields (a frozen copy), so a consumer can check its own mapping at activation. */
  readonly fields: Readonly<Record<string, Readonly<FieldSpec>>>;
  /** Creates a record, stamping the principal as its owner on an owned collection. */
  create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>): Promise<StoreRecordResult>;
  /** One record in the principal's scope. */
  get(principal: StorePrincipal, id: string): StoreRecordResult;
  /**
   * A partial update (the HTTP API's PATCH): only the supplied fields change, and a field set to `null` is removed. A
   * `null` for a required (or increment) field is refused with a 400 field error. With `ifMatch`, a record changed
   * since that ETag is refused with 412.
   */
  update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar | null>>, options?: { ifMatch?: string }): Promise<StoreRecordResult>;
  /**
   * One page of the principal's scope (the HTTP API's unsorted `GET` list, in creation order): on an owned collection
   * only the principal's own records, and `total` counts only those. `limit` is capped at the collection's
   * `pageSize`. `cursor` is a `next` or `previous` value an earlier page returned; anything else is a 400.
   */
  list(principal: StorePrincipal, options?: { limit?: number; cursor?: string }): StoreListResult;
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

function records(collection: Collection): StoreRecords {
  const fields = Object.freeze(Object.fromEntries(Object.entries(collection.spec.fields).map(([name, spec]) => [name, Object.freeze({ ...spec, ...(spec.enum ? { enum: Object.freeze([...spec.enum]) } : {}) })]))) as Readonly<Record<string, Readonly<FieldSpec>>>;
  return Object.freeze({
    name: collection.name, ownership: collection.spec.ownership, readOnly: collection.spec.readOnly, fields,
    async create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>) { return result(await collection.create({ ...values }, undefined, ownerOf(principal), actorOf(principal))); },
    get(principal: StorePrincipal, id: string) { return result(collection.get(known(id), ownerOf(principal))); },
    async update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar | null>>, options: { ifMatch?: string } = {}) {
      if (options.ifMatch !== undefined && (typeof options.ifMatch !== 'string' || !/^"[0-9a-f]{32}"$/.test(options.ifMatch))) throw new StoreError(400, 'invalid_if_match', 'If-Match must be one strong quoted ETag this store issued');
      return result(await collection.update(known(id), { ...patch }, false, undefined, options.ifMatch, ownerOf(principal), actorOf(principal)));
    },
    list(principal: StorePrincipal, options: { limit?: number; cursor?: string } = {}) {
      const invalid = (field: string, message: string) => new StoreError(400, 'invalid_query', 'The query is not valid', { [field]: message });
      if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw invalid('limit', 'must be a positive integer');
      if (options.cursor !== undefined && typeof options.cursor !== 'string') throw invalid('cursor', 'must be a cursor this store issued');
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      if (options.cursor !== undefined) params.set('cursor', options.cursor);
      // The same parser and scoping as the HTTP list: an unsorted page, whose cursor is the offset into creation order.
      const page = collection.list(params, ownerOf(principal));
      const limit = Math.min(options.limit ?? collection.spec.pageSize, collection.spec.pageSize), offset = options.cursor === undefined ? 0 : Number(options.cursor);
      return Object.freeze({
        items: Object.freeze(page.items.map(view)), total: page.total,
        ...(page.next === undefined ? {} : { next: String(page.next) }),
        ...(offset > 0 ? { previous: String(Math.max(0, offset - limit)) } : {}),
      });
    },
  });
}

/**
 * The export object and the two calls the registration makes: `attach` when an activation has loaded its
 * collections, and `detach` (with the token `attach` returned) when that activation closes. A newer activation's
 * collections are never detached by an older one's close.
 */
export function storeExports(): { exports: StoreExports; attach(collections: readonly Collection[]): symbol; detach(token: symbol): void } {
  let current: { token: symbol; byName: Map<string, StoreRecords> } | undefined;
  const exports: StoreExports = Object.freeze({
    version: 1 as const,
    get active() { return current !== undefined; },
    records(name: string): StoreRecords {
      if (!current) throw new Error('store is not active yet: the runtime activates store before the extensions that require it, so call records() from activate or a request, not from host()');
      const found = typeof name === 'string' ? current.byName.get(name) : undefined;
      if (!found) throw new Error(`store declares no collection ${String(name).slice(0, 64)}`);
      return found;
    },
  });
  return {
    exports,
    attach(collections) { const token = Symbol('store activation'); current = { token, byName: new Map(collections.map(collection => [collection.name, records(collection)])) }; return token; },
    detach(token) { if (current?.token === token) current = undefined; },
  };
}
