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
  /** A partial update (the HTTP API's PATCH): only the supplied fields change. With `ifMatch`, a record changed since that ETag is refused with 412. */
  update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar>>, options?: { ifMatch?: string }): Promise<StoreRecordResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const view = (record: StoredRecord): Readonly<StoredRecord> => { const { [OWNER_FIELD]: _owner, ...rest } = record; return Object.freeze(rest); };
const result = (record: StoredRecord): StoreRecordResult => Object.freeze({ record: view(record), etag: etagOf(record) });
const ownerOf = (principal: StorePrincipal): string | undefined => principal === null || principal === undefined ? undefined : principal.id;
const known = (id: string): string => { if (typeof id !== 'string' || !UUID.test(id)) throw new StoreError(404, 'not_found', 'No such record'); return id; };

function records(collection: Collection): StoreRecords {
  const fields = Object.freeze(Object.fromEntries(Object.entries(collection.spec.fields).map(([name, spec]) => [name, Object.freeze({ ...spec, ...(spec.enum ? { enum: Object.freeze([...spec.enum]) } : {}) })]))) as Readonly<Record<string, Readonly<FieldSpec>>>;
  return Object.freeze({
    name: collection.name, ownership: collection.spec.ownership, readOnly: collection.spec.readOnly, fields,
    async create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>) { return result(await collection.create({ ...values }, undefined, ownerOf(principal))); },
    get(principal: StorePrincipal, id: string) { return result(collection.get(known(id), ownerOf(principal))); },
    async update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar>>, options: { ifMatch?: string } = {}) {
      if (options.ifMatch !== undefined && (typeof options.ifMatch !== 'string' || !/^"[0-9a-f]{32}"$/.test(options.ifMatch))) throw new StoreError(400, 'invalid_if_match', 'If-Match must be one strong quoted ETag this store issued');
      return result(await collection.update(known(id), { ...patch }, false, undefined, options.ifMatch, ownerOf(principal)));
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
      if (!current) throw new Error('store is not active yet: declare store before the extension that uses it under extensions in urlcode.yaml, so the runtime activates it first');
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
