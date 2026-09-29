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
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
   *
   * With `options.idempotencyKey` (#902) the transaction is retry-safe: the key's claim is read under the write lock,
   * so of racing calls with one key exactly one runs `work`. Its return value, which must then be a JSON value (or
   * `undefined`) of at most `TRANSACTION_RETRIES.resultBytes` bytes serialized, is kept with the claim in the same
   * transaction, and a later call with the key and the same `fingerprint` returns a copy of it without running `work`
   * or writing anything. A different fingerprint is a 422 `idempotency_key_reused` `StoreError`. A transaction that
   * throws keeps nothing, so its retry runs again. Keys are store-wide: prefix them with the caller's own scope.
   */
  transaction<T>(work: (tx: StoreTransaction) => T, options?: StoreTransactionOptions): T;
}
/** Makes a host transaction retry-safe (`StoreExports.transaction`). */
export interface StoreTransactionOptions {
  /** The caller's key for this logical operation, 1 to `TRANSACTION_RETRIES.keyLength` characters; stored only as a hash. */
  idempotencyKey: string;
  /**
   * What the operation is (for example the canonical request it serves), at most `TRANSACTION_RETRIES.fingerprintLength`
   * characters; stored only as a hash. A retry with the key must carry the same one (absent counts as the empty string).
   */
  fingerprint?: string;
}
/**
 * Host transaction retry bounds: the key and fingerprint lengths a caller may pass, the largest result kept (its JSON
 * in bytes), and how many keys the store retains, newest first; an evicted key's retry runs again.
 */
export const TRANSACTION_RETRIES = { keyLength: 256, fingerprintLength: 4096, resultBytes: 16_384, keys: 1_000 } as const;
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
  /** Runs a declared transfer, exactly as its HTTP endpoint does (without an `Idempotency-Key`; `ifMatch` is the debited record's). */
  transfer(principal: StorePrincipal, name: string, request: StoreTransferRequest, options?: { ifMatch?: string }): StoreTransferResult;
  list(principal: StorePrincipal, options?: { limit?: number; cursor?: string }): StoreListResult;
}
/** A declared transfer's request (#902): the debited and credited record ids and the positive whole amount moved. */
export interface StoreTransferRequest { readonly from: string; readonly to: string; readonly amount: number }
/** A transfer's result: the debited record, and the credited one only when the principal may read it. */
export interface StoreTransferResult { readonly from: StoreRecordResult; readonly to?: StoreRecordResult }
/** A record as a caller sees it (never its stored owner) and its strong ETag. */
export interface StoreRecordResult { readonly record: Readonly<StoredRecord>; readonly etag: string }
/** The principal of the request being served (`request.principal`); `null`/`undefined` when it has none. */
export type StorePrincipal = Pick<ExtensionPrincipal, 'id'> | null | undefined;
export interface StoreRecords {
  readonly name: string;
  readonly ownership: Ownership;
  readonly readOnly: boolean;
  /** The record schema (a deep-frozen copy; a named one resolved), so a consumer can check its own mapping at activation. */
  readonly schema: Readonly<RecordSchema>;
  /** The collection's `defaults`: the value a create stores for each property it omits. */
  readonly defaults: Readonly<Record<string, Scalar>>;
  /** The collection's `readOnlyProperties`: only a declared transition changes them, and a create or update naming one is refused. */
  readonly readOnlyProperties: readonly string[];
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
  /** Runs the declared transfer `name` in its own transaction (its HTTP endpoint without an `Idempotency-Key`). */
  transfer(principal: StorePrincipal, name: string, request: StoreTransferRequest, options?: { ifMatch?: string }): Promise<StoreTransferResult>;
}
/** One list page. `next` and `previous` are the cursors of the adjacent pages, absent at either end. */
export interface StoreListResult { readonly items: readonly Readonly<StoredRecord>[]; readonly total: number; readonly next?: string; readonly previous?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const view = (record: StoredRecord): Readonly<StoredRecord> => { const { [OWNER_FIELD]: _owner, ...rest } = record; return Object.freeze(rest); };
const result = (record: StoredRecord): StoreRecordResult => Object.freeze({ record: view(record), etag: etagOf(record) });
/** A caller's transfer request as a plain object, so the generated body schema judges exactly what was passed. */
const plain = (request: StoreTransferRequest): unknown => request !== null && typeof request === 'object' ? { ...request } : request;
const transferResult = (from: StoredRecord, to: StoredRecord | undefined): StoreTransferResult => Object.freeze({ from: result(from), ...(to === undefined ? {} : { to: result(to) }) });
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

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The hashed key and fingerprint of an idempotent host transaction, or `undefined` without a key. Misuse is a TypeError. */
function retryOf(options: StoreTransactionOptions | undefined): { key: string; fingerprint: string } | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object') throw new TypeError('transaction options must be an object');
  const { idempotencyKey, fingerprint = '' } = options;
  if (idempotencyKey === undefined) return undefined;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > TRANSACTION_RETRIES.keyLength) throw new TypeError(`idempotencyKey must be a string of 1 to ${TRANSACTION_RETRIES.keyLength} characters`);
  if (typeof fingerprint !== 'string' || fingerprint.length > TRANSACTION_RETRIES.fingerprintLength) throw new TypeError(`fingerprint must be a string of at most ${TRANSACTION_RETRIES.fingerprintLength} characters`);
  return { key: sha256(idempotencyKey), fingerprint: sha256(fingerprint) };
}
/**
 * An idempotent transaction's result as it is kept: its JSON (null for `undefined`). A value JSON would change (a
 * Date, a Map, NaN, a class instance) or one over the size bound throws, which rolls the transaction back, so a
 * replay always returns exactly what the first call returned.
 */
function kept(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { text = undefined; }
  if (text === undefined || !isDeepStrictEqual(JSON.parse(text), value)) throw new TypeError('An idempotent store transaction must return a JSON value or undefined: its result is kept for replay, so nothing it did was committed');
  if (Buffer.byteLength(text) > TRANSACTION_RETRIES.resultBytes) throw new RangeError(`An idempotent store transaction's result must serialize to at most ${TRANSACTION_RETRIES.resultBytes} bytes of JSON, so nothing it did was committed; return ids rather than records`);
  return text;
}

/**
 * One host transaction over the activation's collections. Every operation is a write step from collection.ts run on
 * the one open database, the first write to each collection after its declaration fence; audited collections are
 * woken after the commit. `open` turns false when `work` returns, so a
 * handle kept past the transaction (for example across an `await`) refuses instead of writing outside it.
 */
function runTransaction<T>(byName: Map<string, Collection>, work: (tx: StoreTransaction) => T, options?: StoreTransactionOptions): T {
  if (typeof work !== 'function') throw new TypeError('transaction needs a synchronous function');
  const retry = retryOf(options);
  const first = byName.values().next().value as Collection | undefined;
  if (!first) throw new Error('store declares no collections');
  const db: StoreDatabase = first.database();
  const audited = new Set<Collection>();
  let open = true;
  const live = (): void => { if (!open) throw new Error('This store transaction has ended; use tx only inside the transaction function'); };
  const step = (collection: Collection, done: Step): StoredRecord | undefined => { if (done.audited) audited.add(collection); return done.record; };
  // The declaration fence (#927), once per collection this transaction writes, before its first write step: a
  // transaction that only reads a collection is not refused for it.
  const fenced = new Set<Collection>();
  const writing = (collection: Collection): void => { live(); if (!fenced.has(collection)) { collection.fenced(db); fenced.add(collection); } };
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
          create(principal: StorePrincipal, values: Readonly<Record<string, Scalar>>) { writing(collection); return result(step(collection, collection.createFor(db, { ...values }, ownerOf(principal), actorOf(principal)))!); },
          get(principal: StorePrincipal, id: string) { live(); return result(collection.getIn(db, known(id), ownerOf(principal))); },
          update(principal: StorePrincipal, id: string, patch: Readonly<Record<string, Scalar | null>>, options: { ifMatch?: string } = {}) { writing(collection); return result(step(collection, collection.updateFor(db, known(id), { ...patch }, matchOf(options), ownerOf(principal), actorOf(principal)))!); },
          remove(principal: StorePrincipal, id: string, options: { ifMatch?: string } = {}) { writing(collection); step(collection, collection.removeFor(db, known(id), matchOf(options), ownerOf(principal), actorOf(principal))); },
          transition(principal: StorePrincipal, id: string, transition: string, options: { ifMatch?: string } = {}) { writing(collection); return result(step(collection, collection.transitionIn(db, known(id), String(transition), matchOf(options), ownerOf(principal), actorOf(principal)))!); },
          transfer(principal: StorePrincipal, transfer: string, request: StoreTransferRequest, options: { ifMatch?: string } = {}) {
            writing(collection);
            const done = collection.transferIn(db, String(transfer), plain(request), matchOf(options), ownerOf(principal), actorOf(principal));
            step(collection, done);
            return transferResult(done.record, collection.visible(done.to, ownerOf(principal)) ? done.to : undefined);
          },
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
      if (retry) {
        // Read under the write lock: of racing calls with one key, exactly one gets past here without a claim.
        const claimed = db.get<{ fingerprint: string; result: string | null }>('SELECT fingerprint, result FROM store_transaction_results WHERE key = ?', retry.key);
        if (claimed) {
          open = false;
          if (claimed.fingerprint !== retry.fingerprint) throw new StoreError(422, 'idempotency_key_reused', 'This idempotency key was already used for a different operation');
          return (claimed.result === null ? undefined : JSON.parse(claimed.result)) as T;
        }
      }
      let returned: T;
      try {
        returned = work(tx);
        if (returned !== null && typeof returned === 'object' && typeof (returned as { then?: unknown }).then === 'function') throw new TypeError('A store transaction function must be synchronous: it returned a promise, so nothing it did was committed');
      } finally { open = false; }
      if (retry) {
        db.run('INSERT INTO store_transaction_results(key, fingerprint, result, claimed_at) VALUES (?, ?, ?, ?)', retry.key, retry.fingerprint, kept(returned), Date.now());
        db.run('DELETE FROM store_transaction_results WHERE seq <= (SELECT seq FROM store_transaction_results ORDER BY seq DESC LIMIT 1 OFFSET ?)', TRANSACTION_RETRIES.keys);
      }
      return returned;
    });
  } catch (error) { return storageFailure(error, true); }
  for (const collection of audited) collection.notifyAudit();
  return value;
}

function records(collection: Collection): StoreRecords {
  return Object.freeze({
    name: collection.name, ownership: collection.spec.ownership, readOnly: collection.spec.readOnly, schema: collection.spec.records.schema, defaults: collection.spec.records.defaults, readOnlyProperties: collection.spec.records.readOnly,
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
    async transfer(principal: StorePrincipal, name: string, request: StoreTransferRequest, options: { ifMatch?: string } = {}) {
      const done = collection.transfer(String(name), plain(request), undefined, matchOf(options), ownerOf(principal), actorOf(principal));
      return transferResult(done.from!, done.to);
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
    transaction<T>(work: (tx: StoreTransaction) => T, options?: StoreTransactionOptions): T {
      if (!current) throw new Error('store is not active yet: run transactions from activate or a request, not from host()');
      return runTransaction(current.collections, work, options);
    },
  });
  return {
    exports,
    attach(collections) { const token = Symbol('store activation'); current = { token, byName: new Map(collections.map(collection => [collection.name, records(collection)])), collections: new Map(collections.map(collection => [collection.name, collection])) }; attached.push(current); return token; },
    detach(token) { const index = attached.findIndex(entry => entry.token === token); if (index >= 0) attached.splice(index, 1); current = attached.at(-1); },
  };
}
