import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ExtensionHttpError, isSameOriginRequest, jsonResponse, readBody } from '@jimhoyd/urlcode/extensions';
import type { ExtensionActivation, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { Collection, OWNER_FIELD, StoreError, collectionSchema, etagOf } from './collection.ts';
import type { CollectionAuditor, CollectionSpec, Retry, StoredRecord, Written } from './collection.ts';
import type { AuditAttachment, AuditEvent, AuditExports } from '@jimhoyd/urlcode-audit';
import { openStoreDatabase } from './database.ts';
import type { StoreDatabase } from './database.ts';
import { screensSchema, storeScreens } from './screens.ts';
import { storeExports } from './records.ts';
import { storeAuthoring } from './authoring.ts';
import type { StoreExports } from './records.ts';

export interface StoreExtensionOptions {
  /**
   * Absolute path of the store's SQLite database, one per site (created 0600, its directory 0700, when absent). It
   * must be outside the route project. Every collection, retained Idempotency-Key and undelivered audit event lives in it.
   */
  database: string;
  /** Exact project revision the operator reviewed (`inspectExtensionRevision`). */
  projectSha256: string;
  /**
   * The audit extension's exports when it is installed (`ctx.get('audit')`; store `uses` audit). A collection that
   * declares `audit: true` refuses to activate without an active one.
   */
  audit?: AuditExports | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD = /^[a-z][A-Za-z0-9_]{0,63}$/;
const json = (status: number, value: unknown, extra: [string, string][] = []): HandlerResult => jsonResponse(status, value, extra);
const failure = (error: StoreError, extra: [string, string][] = []): HandlerResult =>
  json(error.status, { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }, extra);
/** What a caller sees of a record: everything but the stored owner, which never leaves the database. */
const view = (record: StoredRecord): StoredRecord => { if (!Object.hasOwn(record, OWNER_FIELD)) return record; const { [OWNER_FIELD]: _owner, ...rest } = record; return rest; };
const listView = (page: { items: StoredRecord[]; total: number; next?: string | number }) => ({ ...page, items: page.items.map(view) });

/** Resolves symlinks through the deepest ancestor that exists, so a not-yet-created path compares correctly. */
async function realTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { const parent = dirname(path); return parent === path ? path : join(await realTarget(parent), basename(path)); }
}

/**
 * Checks the whole outbox before audit may drain it: every row is a store event whose id matches its column, and
 * with audit installed each one passes audit's own validation. A database edited by hand refuses activation instead
 * of making the drain stop the producer mid-way.
 */
function checkOutbox(db: StoreDatabase, auditor: CollectionAuditor | undefined): number {
  const rows = db.all<{ id: string; event: string }>('SELECT id, event FROM store_audit_outbox ORDER BY seq');
  for (const row of rows) {
    let event: unknown;
    try { event = JSON.parse(row.event); } catch { event = undefined; }
    const valid = event !== null && typeof event === 'object' && (event as AuditEvent).id === row.id && (event as AuditEvent).source === 'store';
    try { if (!valid) throw new Error('invalid'); auditor?.validate(event); }
    catch { throw new Error('The store database holds invalid audit events'); }
  }
  return rows.length;
}

/** The `extensions.store.config` schema: the registration and the extension definition share this one object. */
export const storeConfigSchema = { type: 'object', additionalProperties: false, required: ['collections'], properties: {
  collections: { type: 'object', maxProperties: 32, propertyNames: { pattern: NAME.source }, additionalProperties: collectionSchema, description: 'Collections by name, each stored as rows of the site\'s store database (data/store.sqlite outside app/, chosen by the operator) and served as a bounded CRUD API at its mount.' },
  shortLinks: { description: 'Public redirect mounts by name: GET <mount>/<key> atomically increments a counter and answers 302 to the record\'s stored destination; HEAD answers the same 302 without counting; an unknown key is 404. Each needs a route <mount>/* with extension: store (GET, HEAD).', type: 'object', maxProperties: 32, propertyNames: { pattern: NAME.source }, additionalProperties: {
    type: 'object', additionalProperties: false, required: ['mount', 'collection', 'destination', 'clicks'], properties: {
      mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256, description: 'URL path of the redirect mount, separate from the collection\'s CRUD mount.' },
      collection: { type: 'string', pattern: NAME.source, description: 'A declared shared collection with a key; the key value is the path segment after the mount.' },
      destination: { type: 'string', pattern: FIELD.source, description: 'A required string field with format: http-url holding the redirect target; activation refuses it otherwise.' },
      clicks: { type: 'string', pattern: FIELD.source, description: 'A field listed in the collection\'s increments, raised by one on each GET (even when the collection is readOnly).' },
    },
  } },
  screens: screensSchema,
} };

/** The operator-installed registration. Storage location and the revision pin are operator choices, never project YAML. */
export function storeExtension(options: StoreExtensionOptions): RuntimeExtension {
  return createStore(options).registration;
}
/**
 * The registration and its `StoreExports` (#529), the typed records API an extension that `requires: [store]`
 * reads through `ctx.get('store')`; usable once the runtime has activated this registration.
 *
 * The registration owns one connection to the database, opened by its first activation and closed with its last. A
 * dev reload activates the replacement while the serving activation is still live (core RIM-EXT-HANDOFF-001); both
 * are views over the same connection, so there is no second writer and nothing to hand off.
 *
 * With `audit`, the store attaches itself as the audit producer `store` once, here: its outbox is the
 * `store_audit_outbox` table, which audit drains (peek, then ack in a transaction). `close` detaches it; the host
 * calls it before the store's database is released.
 */
export function createStore(options: StoreExtensionOptions): { registration: RuntimeExtension; exports: StoreExports; close(): Promise<void> } {
  if (typeof options.database !== 'string' || !isAbsolute(options.database)) throw new Error('Store database must be an absolute path');
  const database = resolve(options.database);
  const shared = storeExports(), audit = options.audit;
  // The live activations, oldest first. The newest is the one being served; the producer drains only while one is live.
  const live: symbol[] = [];
  // The one connection and how many live activations hold it.
  let connection: Connection | undefined;
  const acquire = async (): Promise<{ db: StoreDatabase; release(): Promise<void> }> => {
    const held: Connection = connection ?? opener(database);
    connection = held;
    held.refs++;
    let db: StoreDatabase;
    try { db = await held.opening; }
    catch (error) { if (--held.refs === 0 && connection === held) connection = undefined; throw error; }
    let released = false;
    return { db, async release() {
      if (released) return;
      released = true;
      if (--held.refs > 0) return;
      if (connection === held) connection = undefined;
      db.close();
    } };
  };
  const current = (): StoreDatabase | undefined => live.length && connection?.db?.open ? connection.db : undefined;
  const attachment: AuditAttachment | undefined = audit?.attach({
    source: 'store',
    // The oldest pending events across every collection: audit's flush settles once a peek holds only newer events,
    // so an older event left behind would be missed.
    async peek(limit) {
      const db = current();
      return db ? db.all<{ event: string }>('SELECT event FROM store_audit_outbox ORDER BY at, seq LIMIT ?', limit).map(row => JSON.parse(row.event) as AuditEvent) : [];
    },
    async ack(ids) {
      const db = current();
      if (db && ids.length) db.transaction(() => { db.run('DELETE FROM store_audit_outbox WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)); });
    },
  });
  const auditor: CollectionAuditor | undefined = audit && attachment ? { validate: value => audit.validate(value), notify: () => attachment.notify() } : undefined;
  const registration: RuntimeExtension = {
    name: 'store', version: '1', projectSha256: options.projectSha256, targets: ['node'],
    schema: storeConfigSchema,
    authoring: storeAuthoring,
    async activate(config, context): Promise<ExtensionInstance> {
      const rel = relative(await realTarget(resolve(context.root)), await realTarget(database));
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Store database must be outside the route project');
      const declared = (config as { collections: Record<string, CollectionSpec>; shortLinks?: Record<string, ShortLinkSpec> }).collections;
      const declaredLinks = (config as { shortLinks?: Record<string, ShortLinkSpec> }).shortLinks ?? {};
      // Screens are served by ui, but they name store collections, so an unknown one refuses here too.
      storeScreens(config);
      const byMount = new Map<string, Collection>();
      const collections = Object.entries(declared).map(([name, spec]) => new Collection(name, spec, auditor));
      for (const collection of collections) if (collection.spec.audit && !audit?.active) throw new Error(`collection ${collection.name} declares audit: true; install the audit extension (urlcode extensions add audit)`);
      for (const collection of collections) {
        if (byMount.has(collection.spec.mount)) throw new Error(`Collections ${byMount.get(collection.spec.mount)!.name} and ${collection.name} share a mount`);
        byMount.set(collection.spec.mount, collection);
      }
      const shortByMount = new Map<string, ShortLink>();
      for (const [name, link] of Object.entries(declaredLinks)) {
        const collection = collections.find(candidate => candidate.name === link.collection);
        if (!collection) throw new Error(`Short link ${name}: collection ${link.collection} is not declared`);
        if (!collection.spec.key) throw new Error(`Short link ${name}: collection ${link.collection} needs a declared key`);
        const destination = collection.spec.fields[link.destination];
        if (!destination || destination.type !== 'string' || destination.format !== 'http-url' || !destination.required) throw new Error(`Short link ${name}: destination must name a required string field with format http-url`);
        if (!collection.spec.increments.includes(link.clicks)) throw new Error(`Short link ${name}: clicks must name a declared increment field`);
        if (byMount.has(link.mount) || shortByMount.has(link.mount)) throw new Error(`Short link ${name}: mount ${link.mount} conflicts with a collection or short link mount`);
        if (!context.mounts.includes(link.mount)) throw new Error(`Short link ${name}: route ${link.mount}/* with extension: store is not declared`);
        shortByMount.set(link.mount, { collection, destination: link.destination, clicks: link.clicks });
      }
      for (const collection of collections) if (!context.mounts.includes(collection.spec.mount)) throw new Error(`Collection ${collection.name}: route ${collection.spec.mount}/* with extension: store is not declared`);
      // A `by: others` transition is served on its own mount, so the operator guards who may run it with that route's
      // policy, separately from the collection's. The store has no roles: the route is the only gate.
      const transitionByMount = new Map<string, TransitionMount>();
      for (const collection of collections) for (const [name, transition] of Object.entries(collection.spec.transitions)) {
        if (transition.mount === undefined) continue;
        const where = `Collection ${collection.name}: transition ${name}`;
        if (byMount.has(transition.mount) || shortByMount.has(transition.mount) || transitionByMount.has(transition.mount)) throw new Error(`${where}: mount ${transition.mount} conflicts with another store mount`);
        if (!context.mounts.includes(transition.mount)) throw new Error(`${where}: route ${transition.mount}/* with extension: store is not declared`);
        if (!(context.principalMounts ?? []).includes(transition.mount)) throw new Error(`${where}: by: others needs route ${transition.mount}/* guarded by a principal-providing policy (for example auth: true)`);
        transitionByMount.set(transition.mount, { collection, name });
      }
      // Fail closed at startup: an owned collection is only served on a mount where a request can carry a principal.
      const principalMounts = context.principalMounts ?? [];
      for (const collection of collections) if (collection.spec.ownership === 'owner' && !principalMounts.includes(collection.spec.mount)) throw new Error(`Collection ${collection.name}: ownership: owner needs route ${collection.spec.mount}/* guarded by a principal-providing policy (for example auth: true)`);
      // Audit retention is shared with auth's privileged events, so writes nobody has to authenticate for must not
      // be able to fill it: an audited collection is only served where a request can carry a principal.
      for (const collection of collections) if (collection.spec.audit && !principalMounts.includes(collection.spec.mount)) throw new Error(`Collection ${collection.name}: audit: true needs route ${collection.spec.mount}/* guarded by a principal-providing policy (for example auth: true)`);
      for (const mount of context.mounts) if (!byMount.has(mount) && !shortByMount.has(mount) && !transitionByMount.has(mount)) throw new Error(`Mount ${mount} has no collection, transition or short link declared`);
      const held = await acquire();
      let pending: number;
      try {
        pending = checkOutbox(held.db, auditor);
        for (const collection of collections) collection.open(held.db);
      } catch (error) { await held.release(); throw error; }
      const exported = shared.attach(collections);
      live.push(exported);
      // Events a previous run left in the outbox drain now rather than at the next write or poll.
      if (pending > 0) attachment?.notify();
      let closed = false;
      return {
        handle: request => dispatch({ byMount, shortByMount, transitionByMount }, context, request),
        async close() {
          if (closed) return;
          closed = true;
          shared.detach(exported);
          const index = live.indexOf(exported);
          if (index >= 0) live.splice(index, 1);
          for (const collection of collections) collection.close();
          await held.release();
        },
      };
    },
  };
  return { registration, exports: shared.exports, close: async () => { await attachment?.close(); } };
}

/** The registration's one connection while any activation holds it. */
interface Connection { readonly opening: Promise<StoreDatabase>; db?: StoreDatabase; refs: number }
function opener(database: string): Connection {
  const connection: Connection = { opening: openStoreDatabase(database), refs: 0 };
  connection.opening.then(db => { connection.db = db; }, () => undefined);
  return connection;
}
interface ShortLinkSpec { mount: string; collection: string; destination: string; clicks: string }
interface ShortLink { collection: Collection; destination: string; clicks: string }
interface TransitionMount { collection: Collection; name: string }
interface Mounts { byMount: Map<string, Collection>; shortByMount: Map<string, ShortLink>; transitionByMount: Map<string, TransitionMount> }

/** Store's own wording for the codes it has always answered; any other refusal keeps core's code and fixed message. */
const bodyMessages: Readonly<Record<string, string>> = { unsupported_media_type: 'Send Content-Type: application/json', invalid_json: 'Body is not valid JSON' };
/**
 * The JSON body through core's bounded reader (size, media type, fatal UTF-8, duplicate keys, depth). A refusal is a
 * StoreError with core's status and code, except that an oversized body keeps store's `record_too_large`.
 */
function bodyOf(request: ExtensionRequest, collection: Collection): unknown {
  try { const body = readBody(request, { accept: ['json'], maxBytes: collection.spec.maxRecordBytes + 4096 }); return body.kind === 'json' ? body.value : undefined; }
  catch (error) {
    if (!(error instanceof ExtensionHttpError)) throw error;
    if (error.status === 413) throw new StoreError(413, 'record_too_large', 'Request body is too large');
    throw new StoreError(error.status, error.code, bodyMessages[error.code] ?? error.message);
  }
}
/** A JSON value with object keys sorted at every depth: two bodies that differ only in key order fingerprint alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/**
 * The request's `Idempotency-Key` scoped to its caller (#835), or `undefined` without the header. The raw value is hashed
 * with the caller's scope into one fixed-length opaque key: the request principal when there is one (so a signed-in
 * caller's retry replays from another network address, and another principal's identical key never collides), or the
 * network client the runtime attributed the request to (a fixed marker when unknown) when there is none. An
 * unauthenticated mount has no stronger caller identity than that to scope by. A key on a collection without
 * `idempotency` is a 400 here, before the body is read. `retryOf` adds the request fingerprint: the method, the path
 * and the canonical JSON body (empty when the request has none); `If-Match` is not part of it.
 */
function retryKey(request: ExtensionRequest, collection: Collection): string | undefined {
  const key = request.headers.get('idempotency-key');
  if (key === null) return undefined;
  if ((request.headerCounts['idempotency-key'] ?? 1) !== 1 || key.length < 1 || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) throw new StoreError(400, 'invalid_idempotency_key', 'Idempotency-Key must be one header value no longer than 128 characters');
  collection.idempotencyConfig(key);
  const principal = request.principal?.id;
  const scope = principal === undefined ? `client\u0000${request.client ?? '<unknown>'}` : `principal\u0000${principal}`;
  return hash(`${scope}\u0000${key}`);
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The `Retry` for a scoped key (see `retryKey`) and the request it arrived with. */
function retryOf(request: ExtensionRequest, key: string | undefined, body?: unknown): Retry | undefined {
  return key === undefined ? undefined : { key, fingerprint: hash(`${request.method.toUpperCase()}\u0000${request.path}\u0000${body === undefined ? '' : canonical(body)}`) };
}
/** A bare `If-Match` value (this store never emits a weak or list-form ETag, so it only accepts
 * exactly one strong quoted value); `undefined` for an absent header, `null` for a malformed one. */
function ifMatch(request: ExtensionRequest): string | undefined {
  const value = request.headers.get('if-match');
  if (value === null) return undefined;
  if ((request.headerCounts['if-match'] ?? 1) !== 1 || !/^"[0-9a-f]{32}"$/.test(value)) throw new StoreError(400, 'invalid_if_match', 'If-Match must be one strong quoted ETag this store issued');
  return value;
}
/** The answer to a write: its status, the record with its ETag (a create adds `Location`), and whether it was replayed. */
function written(outcome: Written, location?: string): HandlerResult {
  const replayed: [string, string][] = outcome.replayed ? [['idempotency-replayed', 'true']] : [];
  if (outcome.record === undefined) return { status: outcome.status, headers: [['cache-control', 'no-store'], ...replayed] };
  const record = outcome.record;
  return json(outcome.status, view(record), [...(location === undefined ? [] : [['location', `${location}/${record.id as string}`] as [string, string]]), ['etag', etagOf(record)], ...replayed]);
}
/** A transition takes no body: its effect is declared, and the caller supplies only the record, `If-Match` and the key. */
function noBody(request: ExtensionRequest): void {
  if (request.body.byteLength > 0) throw new StoreError(400, 'body_not_allowed', 'A transition takes no request body');
}
async function dispatch(mounts: Mounts, site: Pick<ExtensionActivation, 'origin' | 'origins'>, request: ExtensionRequest): Promise<HandlerResult> {
  const short = request.mount === null ? undefined : mounts.shortByMount.get(request.mount);
  if (short) return dispatchShortLink(short, request);
  const transition = request.mount === null ? undefined : mounts.transitionByMount.get(request.mount);
  const collection = transition?.collection ?? (request.mount === null ? undefined : mounts.byMount.get(request.mount));
  if (!collection || request.mount === null) return failure(new StoreError(404, 'not_found', 'No such collection'));
  const rest = request.path.slice(request.mount.length).replace(/^\/+/, '');
  const method = request.method.toUpperCase(), write = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const allowed = (methods: string): [string, string][] => [['allow', methods]];
  const principal = request.principal?.id, actor = principal ?? 'anonymous';
  // An owned collection is scoped to the request principal (core's RIM-EXT-PRINCIPAL-001, set by the route's
  // principal-providing policy). Without one, nothing is served: never a fallback to the shared view.
  const owner = collection.spec.ownership === 'owner' ? principal : undefined;
  if (collection.spec.ownership === 'owner' && owner === undefined) return failure(new StoreError(401, 'principal_required', 'Sign in to use this collection'));
  try {
    // Core's same-origin rule with `whenAbsent: 'admit'`: this write API takes application/json only, which a
    // cross-site form cannot send, and non-browser clients (curl, API keys) send no provenance header at all.
    if (write && !isSameOriginRequest(request, site, { whenAbsent: 'admit' })) throw new StoreError(403, 'forbidden_origin', 'Cross-origin writes are refused');
    if (transition) {
      // A transition's own mount serves exactly `POST <mount>/<id>`.
      if (rest.includes('/') || !UUID.test(rest)) throw new StoreError(404, 'not_found', 'No such record');
      if (method !== 'POST') return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('POST'));
      noBody(request);
      const match = ifMatch(request);
      return written(collection.transition(rest, transition.name, retryOf(request, retryKey(request, collection)), match, principal, actor));
    }
    if (rest === '') {
      if (method === 'GET' || method === 'HEAD') return json(200, listView(collection.list(request.query, owner)));
      if (method === 'POST') {
        const key = retryKey(request, collection), body = bodyOf(request, collection);
        return written(collection.create(body, retryOf(request, key, body), owner, actor), request.mount);
      }
      return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, POST'));
    }
    const increment = rest.match(/^([0-9a-f-]{36})\/increment\/([a-z][A-Za-z0-9_]*)$/);
    if (increment && method === 'POST') return written(collection.increment(increment[1]!, increment[2]!, retryOf(request, retryKey(request, collection)), owner, actor));
    const named = rest.match(/^([0-9a-f-]{36})\/([a-z][a-z0-9_-]{0,63})$/);
    // Only transitions served on the collection mount; a `by: others` one answers only on its own mount.
    if (named && UUID.test(named[1]!) && Object.hasOwn(collection.spec.transitions, named[2]!) && collection.spec.transitions[named[2]!]!.mount === undefined) {
      if (method !== 'POST') return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('POST'));
      noBody(request);
      const match = ifMatch(request);
      return written(collection.transition(named[1]!, named[2]!, retryOf(request, retryKey(request, collection)), match, principal, actor));
    }
    if (rest.includes('/') || !UUID.test(rest)) throw new StoreError(404, 'not_found', 'No such record');
    if (method === 'GET' || method === 'HEAD') { const record = collection.get(rest, owner); return json(200, view(record), [['etag', etagOf(record)]]); }
    const match = ifMatch(request);
    if (method === 'PUT' || method === 'PATCH') {
      const key = retryKey(request, collection), body = bodyOf(request, collection);
      return written(collection.update(rest, body, method === 'PUT', retryOf(request, key, body), match, owner, actor));
    }
    if (method === 'DELETE') return written(collection.remove(rest, retryOf(request, retryKey(request, collection)), match, owner, actor));
    return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, PUT, PATCH, DELETE'));
  } catch (error) {
    if (error instanceof StoreError) return failure(error, error.status === 405 ? allowed(transition ? 'POST' : collection.spec.readOnly ? 'GET, HEAD' : 'GET, HEAD, POST, PUT, PATCH, DELETE') : []);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request')); // never echo the cause
  }
}
async function dispatchShortLink(short: ShortLink, request: ExtensionRequest): Promise<HandlerResult> {
  const rest = request.mount === null ? '' : request.path.slice(request.mount.length).replace(/^\/+/, '');
  const method = request.method.toUpperCase();
  try {
    if (!['GET', 'HEAD'].includes(method)) return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), [['allow', 'GET, HEAD']]);
    if (!rest || rest.includes('/')) throw new StoreError(404, 'not_found', 'No such record');
    // HEAD has no side effects: resolve the destination without counting a click. A record
    // missing its (now config-time-required) destination — possible only for data written before
    // that requirement, since re-loading existing data does not retroactively enforce it —
    // answers 404 without incrementing rather than a 302 to `Location: undefined`.
    const target = short.collection.getByKey(rest);
    if (typeof target[short.destination] !== 'string') throw new StoreError(404, 'not_found', 'No such record');
    const record = method === 'HEAD' ? target : short.collection.recordClick(target.id as string, short.clicks);
    return { status: 302, headers: [['location', record[short.destination] as string], ['cache-control', 'no-store']] };
  } catch (error) {
    if (error instanceof StoreError) return failure(error);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request'));
  }
}
