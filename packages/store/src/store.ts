import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ExtensionHttpError, isSameOriginRequest, jsonResponse, principalIdPattern, readBody } from '@jimhoyd/urlcode/extensions';
import type { ExtensionActivation, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { Collection, OWNER_FIELD, StoreError, canonical, collectionSchema, etagOf, redirectable } from './collection.ts';
import type { CollectionAuditor, CollectionSpec, Page, Retry, Shown, StoredRecord, Transferred, Written } from './collection.ts';
import type { AuditAttachment, AuditEvent, AuditExports } from '@jimhoyd/urlcode-audit';
import { auditDrainHolder, holdsAuditDrain, markAuditDrained, openStoreDatabase, recordDeclarations, releaseAuditDrain, storeDurability } from './database.ts';
import type { StoreDatabase, StoreDurability } from './database.ts';
import { storeExports } from './records.ts';
import { storeAuthoring } from './authoring.ts';
import { describeStore } from './openapi.ts';
import type { StoreExports } from './records.ts';
import { hostProbe, joinServers } from './topology.ts';
import type { HostProbe, ServerLease } from './topology.ts';
import { OPERATOR_ACTOR } from './membership.ts';

/** At most how often the drain's last-kept-up time is written (well inside the CLI's AUDIT_DRAIN_STALE_MS). */
const AUDIT_DRAIN_MARK_MS = 10_000;

export interface StoreExtensionOptions {
  /**
   * Absolute path of the store's SQLite database, one per site (created 0600, its directory 0700, when absent). It
   * must be outside the route project. Every collection, retained Idempotency-Key and undelivered audit event lives in it.
   */
  database: string;
  /**
   * How much each commit waits for the disk (#859; docs/STORE.md, durability): `full` (default, SQLite
   * `synchronous=FULL`) or `normal` (`synchronous=NORMAL`: faster commits, but the last ones before a power loss or OS
   * crash can be lost). Anything else is refused. An operator choice, never project YAML.
   */
  durability?: StoreDurability | undefined;
  /** Exact project revision the operator reviewed (`inspectExtensionRevision`). */
  projectSha256: string;
  /**
   * The audit extension's exports when it is installed (`ctx.get('audit')`; store `uses` audit). A collection that
   * declares `audit: true` refuses to activate without an active one.
   */
  audit?: AuditExports | undefined;
  /**
   * Test seam for the setup checks (#927): the filesystem type, hostname and boot id the store reads. Defaults to the
   * real machine; an operator never sets it.
   */
  probe?: Partial<HostProbe> | undefined;
  /**
   * A hermetic run's throwaway store (`HostContext.hermetic`, RIM-EXT-HERMETIC-001): the registration accepts a test seed
   * (`storeSeedSchema`). Never set for `serve`.
   */
  hermetic?: boolean | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/**
 * The test seed a hermetic run accepts (`tests/seed.json` under `store`, RIM-EXT-HERMETIC-001): the members of
 * membership collections, which nobody can add over HTTP. Written as `urlcode-store members add` writes them (actor
 * `operator`), before the first fixture runs. Never accepted on `serve`.
 */
export const storeSeedSchema = {
  type: 'object', additionalProperties: false, required: ['members'],
  properties: {
    members: {
      type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: NAME.source },
      description: 'Principal ids by membership collection (membership: true), such as {"tellers": ["alice"]}.',
      additionalProperties: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', pattern: principalIdPattern.source } },
    },
  },
} as const;
interface StoreSeed { members: Record<string, string[]> }
function seedMembers(collections: readonly Collection[], seed: StoreSeed): void {
  for (const [name, principals] of Object.entries(seed.members)) {
    const collection = collections.find(candidate => candidate.name === name);
    if (!collection?.spec.membership) throw new Error(`seed: members names ${name}, which is not a declared membership collection (membership: true)`);
    for (const principal of principals) collection.create({ [collection.spec.key!]: principal }, undefined, undefined, OPERATOR_ACTOR);
  }
}
const FIELD = /^[a-z][A-Za-z0-9_]{0,63}$/;
const json = (status: number, value: unknown, extra: [string, string][] = []): HandlerResult => jsonResponse(status, value, extra);
const failure = (error: StoreError, extra: [string, string][] = []): HandlerResult =>
  json(error.status, { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}), ...(error.issues ? { issues: error.issues } : {}), ...(error.conflict ? { conflict: error.conflict } : {}) } }, extra);
/** What a caller sees of a record: everything but the stored owner, which only a readers mount with `showOwner` shows. */
const view = (record: StoredRecord): StoredRecord => { if (!Object.hasOwn(record, OWNER_FIELD)) return record; const { [OWNER_FIELD]: _owner, ...rest } = record; return rest; };
/**
 * A list page as the HTTP API answers it: the records, `may` (each listed record's transitions the caller may run
 * now, by id; #873), and `etags`, each listed record's current ETag by id, so a client (a frontend's transition
 * buttons) can offer only what will be accepted and send `If-Match` for the version it listed, without a read per record.
 */
const listView = (page: Page, project: (record: StoredRecord) => StoredRecord = view, tag: (record: StoredRecord) => string = etagOf) => ({ ...page, items: page.items.map(project), etags: Object.fromEntries(page.items.map(record => [record.id as string, tag(record)])) });
/**
 * One record's own headers: its `ETag`, and `Allow-Transitions`, the comma-separated names of the transitions the
 * caller may run on it now (empty when none), the single-record form of a list's `may`.
 */
const recordHeaders = (record: StoredRecord, may: string[] | undefined, tag: (record: StoredRecord) => string = etagOf): [string, string][] => [['etag', tag(record)], ...(may === undefined ? [] : [['allow-transitions', may.join(', ')] as [string, string]])];
const shownAnswer = (shown: Shown, project: (record: StoredRecord) => StoredRecord = view, tag: (record: StoredRecord) => string = etagOf): HandlerResult => json(200, project(shown.record), recordHeaders(shown.record, shown.may, tag));
/**
 * What a projected readers mount (#929) shows of a record: its `id`, the listed properties it holds and, with
 * `showOwner`, `_owner`; never `createdAt`, `updatedAt` or another property. Its ETag is of exactly that, so it changes
 * only when something shown changes: the record's own ETag moves on every write (a transfer included) and would tell
 * every reader when a hidden balance moved.
 */
function projection(properties: readonly string[], showOwner: boolean): { project: (record: StoredRecord) => StoredRecord; tag: (record: StoredRecord) => string } {
  const project = (record: StoredRecord): StoredRecord => Object.fromEntries([['id', record.id!], ...(showOwner && record[OWNER_FIELD] !== undefined ? [[OWNER_FIELD, record[OWNER_FIELD]]] : []), ...properties.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]!])]) as StoredRecord;
  return { project, tag: record => `"${hash(`projection\u0000${canonical(project(record))}`).slice(0, 32)}"` };
}

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
      destination: { type: 'string', pattern: FIELD.source, description: 'A required string property with format: uri holding the redirect target; activation refuses it otherwise, and every write to it takes only an absolute HTTP(S) URL without credentials or whitespace (422 otherwise).' },
      clicks: { type: 'string', pattern: FIELD.source, description: 'A property listed in the collection\'s increments, raised by one on each GET (even when the collection is readOnly).' },
    },
  } },
} };

/** The operator-installed registration. Storage location and the revision pin are operator choices, never project YAML. */
export function storeExtension(options: StoreExtensionOptions): RuntimeExtension {
  return createStore(options).registration;
}
/**
 * The registration and its `StoreExports` (#529), the typed records API an extension that `requires: [store]`
 * reads through `ctx.get('store')`; usable once the runtime has activated this registration. `durability` is the resolved
 * commit durability its connection uses.
 *
 * The registration owns one connection to the database, opened by its first activation and closed with its last. A
 * dev reload activates the replacement while the serving activation is still live (core RIM-EXT-HANDOFF-001); both
 * are views over the same connection, so there is no second writer. Each activation records its collections'
 * declarations (the fence, #927): a retiring activation whose declaration differs has its writes refused, in this
 * process as in another one serving the same database.
 *
 * Opening the connection refuses a database on a network filesystem and joins the database's server leases, refusing a
 * live peer on another host (topology.ts). The lease instance also holds the audit drain's lease, so with several
 * serving processes one drains the outbox.
 *
 * With `audit`, the store attaches itself as the audit producer `store` once, here: its outbox is the
 * `store_audit_outbox` table, which audit drains (peek, then ack in a transaction). `close` detaches it; the host
 * calls it before the store's database is released.
 */
export function createStore(options: StoreExtensionOptions): { registration: RuntimeExtension; exports: StoreExports; durability: StoreDurability; close(): Promise<void> } {
  if (typeof options.database !== 'string' || !isAbsolute(options.database)) throw new Error('Store database must be an absolute path');
  const database = resolve(options.database), durability = storeDurability(options.durability);
  const shared = storeExports(), audit = options.audit, probe: HostProbe = { ...hostProbe, ...options.probe };
  // The live activations, oldest first, with their collections. The newest is the one being served; the producer
  // drains only while one is live.
  const live: { token: symbol; collections: readonly Collection[] }[] = [];
  // Whether this registration already warned that throttles and caches are per process (once, on seeing a live peer).
  let warnedPeers = false;
  // The interval indexes each live activation reads through (#902), so a reload drops only indexes nobody declares.
  const intervalIndexes = new Map<symbol, string[]>();
  // The one connection and how many live activations hold it.
  let connection: Connection | undefined;
  const acquire = async (): Promise<{ db: StoreDatabase; lease: ServerLease; release(): Promise<void> }> => {
    const held: Connection = connection ?? opener(database, durability, probe);
    connection = held;
    held.refs++;
    let opened: { db: StoreDatabase; lease: ServerLease };
    try { opened = await held.opening; }
    catch (error) { if (--held.refs === 0 && connection === held) connection = undefined; throw error; }
    const { db, lease } = opened;
    let released = false;
    return { db, lease, async release() {
      if (released) return;
      released = true;
      if (--held.refs > 0) return;
      if (connection === held) connection = undefined;
      // A peer takes the drain over at its next poll, and this process's server lease goes with it.
      try { releaseAuditDrain(db, lease.instance); } catch { /* The lease expires on its own. */ }
      lease.close();
      db.close();
    } };
  };
  const current = (): { db: StoreDatabase; instance: string } | undefined => live.length && connection?.db?.open && connection.lease ? { db: connection.db, instance: connection.lease.instance } : undefined;
  // When the drain last kept up (an ack, or a peek that found the outbox empty) is written to the database at most
  // every AUDIT_DRAIN_MARK_MS, so the operator CLI can tell a live drain from none (#875) without a write per poll.
  let marked = 0;
  const drained = (db: StoreDatabase): void => {
    const now = Date.now();
    if (now - marked < AUDIT_DRAIN_MARK_MS) return;
    marked = now;
    try { markAuditDrained(db, now); } catch { marked = 0; } // Only a hint for the CLI; a busy lock retries next time.
  };
  const attachment: AuditAttachment | undefined = audit?.attach({
    source: 'store',
    // The oldest pending events across every collection: audit's flush settles once a peek holds only newer events,
    // so an older event left behind would be missed.
    // Only the drain lease's holder peeks and acks (#927): with several serving processes one drains the outbox, and a
    // peer takes over once its lease expired or it closed. A process that does not hold it peeks nothing.
    async peek(limit) {
      const serving = current();
      if (!serving || !holdsAuditDrain(serving.db, serving.instance, Date.now())) return [];
      const events = serving.db.all<{ event: string }>('SELECT event FROM store_audit_outbox ORDER BY at, seq LIMIT ?', limit).map(row => JSON.parse(row.event) as AuditEvent);
      if (!events.length) drained(serving.db);
      return events;
    },
    async ack(ids) {
      const serving = current();
      if (!serving || !ids.length) return;
      const { db, instance } = serving;
      // A holder that lost the lease meanwhile leaves the rows: the new holder delivers them again, stored once by id.
      const acked = db.transaction(() => {
        if (!auditDrainHolder(db, instance)) return false;
        db.run('DELETE FROM store_audit_outbox WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ids));
        return true;
      });
      if (acked) drained(db);
    },
  });
  const auditor: CollectionAuditor | undefined = audit && attachment ? { validate: value => audit.validate(value), notify: () => attachment.notify() } : undefined;
  const registration: RuntimeExtension = {
    name: 'store', version: '1', projectSha256: options.projectSha256, targets: ['node'],
    schema: storeConfigSchema,
    authoring: storeAuthoring,
    // The OpenAPI export's description of each store mount, from the declaration alone (packages/store/src/openapi.ts).
    describe: describeStore,
    ...(options.hermetic === true ? { seedSchema: storeSeedSchema } : {}),
    async activate(config, context): Promise<ExtensionInstance> {
      const rel = relative(await realTarget(resolve(context.root)), await realTarget(database));
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Store database must be outside the route project');
      const declared = (config as { collections: Record<string, CollectionSpec>; shortLinks?: Record<string, ShortLinkSpec> }).collections;
      const declaredLinks = (config as { shortLinks?: Record<string, ShortLinkSpec> }).shortLinks ?? {};
      const byMount = new Map<string, Collection>();
      // A short link's destination property also takes only a redirectable URL, on every write path.
      const destinations = new Map<string, string[]>();
      for (const link of Object.values(declaredLinks)) destinations.set(link.collection, [...destinations.get(link.collection) ?? [], link.destination]);
      const collections = Object.entries(declared).map(([name, spec]) => new Collection(name, spec, auditor, destinations.get(name), context.schemas ?? {}));
      for (const collection of collections) if (collection.spec.audit && !audit?.active) throw new Error(`collection ${collection.name} declares audit: true; install the audit extension (urlcode extensions add audit)`);
      // A membership collection has no mount: it is never served over HTTP.
      const served = collections.filter((collection): collection is Collection & { spec: { mount: string } } => collection.spec.mount !== undefined);
      for (const collection of served) {
        if (byMount.has(collection.spec.mount)) throw new Error(`Collections ${byMount.get(collection.spec.mount)!.name} and ${collection.name} share a mount`);
        byMount.set(collection.spec.mount, collection);
      }
      // A gate names a membership collection; anything else refuses, so a typo can never leave a gate open or shut.
      const membership = (where: string, members: string): void => {
        const found = collections.find(candidate => candidate.name === members);
        if (!found) throw new Error(`${where}: members names ${members}, which is not a declared collection`);
        if (!found.spec.membership) throw new Error(`${where}: members names ${members}, which is not a membership collection (membership: true)`);
      };
      for (const collection of collections) {
        for (const [name, transition] of Object.entries(collection.spec.transitions)) if (transition.members !== undefined) membership(`Collection ${collection.name}: transition ${name}`, transition.members);
        for (const [name, transfer] of Object.entries(collection.spec.transfers)) if (transfer.members !== undefined) membership(`Collection ${collection.name}: transfer ${name}`, transfer.members);
        for (const [name, readers] of Object.entries(collection.spec.readers)) if (readers.members !== undefined) membership(`Collection ${collection.name}: readers ${name}`, readers.members);
        if (collection.spec.create) membership(`Collection ${collection.name}: create`, collection.spec.create.members);
      }
      const shortByMount = new Map<string, ShortLink>();
      for (const [name, link] of Object.entries(declaredLinks)) {
        const collection = collections.find(candidate => candidate.name === link.collection);
        if (!collection) throw new Error(`Short link ${name}: collection ${link.collection} is not declared`);
        if (!collection.spec.key) throw new Error(`Short link ${name}: collection ${link.collection} needs a declared key`);
        const destination = Object.hasOwn(collection.spec.records.properties, link.destination) ? collection.spec.records.properties[link.destination] : undefined;
        if (!destination || destination.type !== 'string' || destination.format !== 'uri' || !collection.spec.records.required.includes(link.destination)) throw new Error(`Short link ${name}: destination must name a required string property with format: uri`);
        if (!collection.spec.increments.includes(link.clicks)) throw new Error(`Short link ${name}: clicks must name a declared increment property`);
        if (byMount.has(link.mount) || shortByMount.has(link.mount)) throw new Error(`Short link ${name}: mount ${link.mount} conflicts with a collection or short link mount`);
        if (!context.mounts.includes(link.mount)) throw new Error(`Short link ${name}: route ${link.mount}/* with extension: store is not declared`);
        shortByMount.set(link.mount, { collection, destination: link.destination, clicks: link.clicks });
      }
      for (const collection of served) if (!context.mounts.includes(collection.spec.mount)) throw new Error(`Collection ${collection.name}: route ${collection.spec.mount}/* with extension: store is not declared`);
      // A `by: others` transition is served on its own mount, so the operator guards who may run it with that route's
      // policy, separately from the collection's, and with `members` the store's membership gate as well.
      const transitionByMount = new Map<string, TransitionMount>();
      for (const collection of collections) for (const [name, transition] of Object.entries(collection.spec.transitions)) {
        if (transition.mount === undefined) continue;
        const where = `Collection ${collection.name}: transition ${name}`;
        if (byMount.has(transition.mount) || shortByMount.has(transition.mount) || transitionByMount.has(transition.mount)) throw new Error(`${where}: mount ${transition.mount} conflicts with another store mount`);
        if (!context.mounts.includes(transition.mount)) throw new Error(`${where}: route ${transition.mount}/* with extension: store is not declared`);
        if (!(context.principalMounts ?? []).includes(transition.mount)) throw new Error(`${where}: by: others needs route ${transition.mount}/* guarded by a principal-providing policy (for example auth: true)`);
        transitionByMount.set(transition.mount, { collection, name });
      }
      // Cross-owner reads are served on their own mount, which must carry a principal for the membership gate.
      const readersByMount = new Map<string, ReadersMount>();
      for (const collection of collections) for (const [name, readers] of Object.entries(collection.spec.readers)) {
        const where = `Collection ${collection.name}: readers ${name}`;
        if (byMount.has(readers.mount) || shortByMount.has(readers.mount) || transitionByMount.has(readers.mount) || readersByMount.has(readers.mount)) throw new Error(`${where}: mount ${readers.mount} conflicts with another store mount`);
        if (!context.mounts.includes(readers.mount)) throw new Error(`${where}: route ${readers.mount}/* with extension: store is not declared`);
        if (!(context.principalMounts ?? []).includes(readers.mount)) throw new Error(`${where}: route ${readers.mount}/* needs a principal-providing policy (for example auth: true)`);
        readersByMount.set(readers.mount, { collection, name });
      }
      // Fail closed at startup: an owned collection is only served on a mount where a request can carry a principal.
      const principalMounts = context.principalMounts ?? [];
      for (const collection of served) if (collection.spec.ownership === 'owner' && !principalMounts.includes(collection.spec.mount)) throw new Error(`Collection ${collection.name}: ownership: owner needs route ${collection.spec.mount}/* guarded by a principal-providing policy (for example auth: true)`);
      // Audit retention is shared with auth's privileged events, so writes nobody has to authenticate for must not
      // be able to fill it: an audited collection is only served where a request can carry a principal.
      for (const collection of served) if (collection.spec.audit && !principalMounts.includes(collection.spec.mount)) throw new Error(`Collection ${collection.name}: audit: true needs route ${collection.spec.mount}/* guarded by a principal-providing policy (for example auth: true)`);
      for (const mount of context.mounts) if (!byMount.has(mount) && !shortByMount.has(mount) && !transitionByMount.has(mount) && !readersByMount.has(mount)) throw new Error(`Mount ${mount} has no collection, transition, readers or short link declared`);
      const held = await acquire();
      if (durability === 'normal') context.warn?.('durability is normal (SQLite synchronous=NORMAL): the last committed writes can be lost on power loss or an OS crash; a process crash loses nothing');
      let pending: number;
      try {
        pending = checkOutbox(held.db, auditor);
        for (const collection of collections) collection.open(held.db);
        // The newest activation wins the declaration fence (#927): from here on a write through an older declaration
        // of any of these collections, in this process or another, is refused.
        record(held.db, collections);
        if (context.seed !== undefined) seedMembers(collections, context.seed as StoreSeed);
      } catch (error) { await held.release(); throw error; }
      if (held.lease.peers > 0 && !warnedPeers) {
        warnedPeers = true;
        context.warn?.(`${held.lease.peers === 1 ? 'another serving process uses' : `${held.lease.peers} other serving processes use`} this store database: throttle policies and origin caches are per process, so each process applies its own limits and caches`);
      }
      const exported = shared.attach(collections);
      live.push({ token: exported, collections });
      intervalIndexes.set(exported, collections.flatMap(collection => collection.intervalIndex ?? []));
      dropStaleIntervalIndexes(held.db, new Set([...intervalIndexes.values()].flat()));
      // Events a previous run left in the outbox drain now rather than at the next write or poll.
      if (pending > 0) attachment?.notify();
      let closed = false;
      return {
        handle: request => dispatch({ byMount, shortByMount, transitionByMount, readersByMount }, context, request),
        async close() {
          if (closed) return;
          closed = true;
          shared.detach(exported);
          intervalIndexes.delete(exported);
          const index = live.findIndex(entry => entry.token === exported);
          if (index >= 0) live.splice(index, 1);
          // A failed reload closes the newest activation: the one still serving is current again, and its declaration
          // is recorded again so its writes pass the fence. A retired (older) activation's close records nothing.
          const serving = live.at(-1);
          if (index >= 0 && index === live.length && serving) { try { record(held.db, serving.collections); } catch { /* Its writes answer 503 until the next activation. */ } }
          for (const collection of collections) collection.close();
          await held.release();
        },
      };
    },
  };
  return { registration, exports: shared.exports, durability, close: async () => { await attachment?.close(); } };
}

/**
 * Drops the interval indexes (#902) that no live activation declares: a changed or removed `intervals` would otherwise
 * leave an index every write keeps paying for. Housekeeping only: an index is never needed for a check to be correct,
 * so a lock another process holds just leaves the drop to the next activation.
 */
function dropStaleIntervalIndexes(db: StoreDatabase, wanted: ReadonlySet<string>): void {
  try {
    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB 'store_intervals_*'"))
      if (!wanted.has(name) && /^store_intervals_[0-9a-f]{24}$/.test(name)) db.run(`DROP INDEX IF EXISTS "${name}"`);
  } catch { /* Retried by the next activation. */ }
}
/** Records `collections`' declarations as the ones served (the fence, #927) and switches their writes to check it. */
function record(db: StoreDatabase, collections: readonly Collection[]): void {
  recordDeclarations(db, new Map(collections.map(collection => [collection.name, collection.fingerprint])), Date.now());
  for (const collection of collections) collection.fence = 'serving';
}
/** The registration's one connection while any activation holds it, and its server lease (topology.ts). */
interface Connection { readonly opening: Promise<{ db: StoreDatabase; lease: ServerLease }>; db?: StoreDatabase; lease?: ServerLease; refs: number }
/**
 * Opens the database (refusing a network filesystem) and joins its server leases (refusing a live peer on another
 * host) before any activation reads it (#927).
 */
function opener(database: string, durability: StoreDurability, probe: HostProbe): Connection {
  const opening = (async () => {
    const db = await openStoreDatabase(database, { durability, probe });
    let lease: ServerLease;
    try { lease = await joinServers(db, probe); } catch (error) { db.close(); throw error; }
    // Every write transaction checks the lease under its write lock first (#978): a process that lost it to another
    // host answers 503 and writes nothing until it holds it again.
    db.writeGuard = () => {
      try { lease.verify(); } catch { throw new StoreError(503, 'storage_unavailable', 'The store is not available'); }
    };
    return { db, lease };
  })();
  const connection: Connection = { opening, refs: 0 };
  opening.then(({ db, lease }) => { connection.db = db; connection.lease = lease; }, () => undefined);
  return connection;
}
interface ShortLinkSpec { mount: string; collection: string; destination: string; clicks: string }
interface ShortLink { collection: Collection; destination: string; clicks: string }
interface TransitionMount { collection: Collection; name: string }
interface ReadersMount { collection: Collection; name: string }
interface Mounts { byMount: Map<string, Collection>; shortByMount: Map<string, ShortLink>; transitionByMount: Map<string, TransitionMount>; readersByMount: Map<string, ReadersMount> }

/** Store's own wording for the codes it has always answered; any other refusal keeps core's code and fixed message. */
const bodyMessages: Readonly<Record<string, string>> = { unsupported_media_type: 'Send Content-Type: application/json', invalid_json: 'Body is not valid JSON' };
/**
 * The JSON body through core's bounded reader (size, media type, fatal UTF-8, duplicate keys, depth). A refusal is a
 * StoreError with core's status and code, except that an oversized body keeps store's `record_too_large`.
 */
function bodyOf(request: ExtensionRequest, collection: Collection): unknown {
  try { return readBody(request, { maxBytes: collection.spec.maxRecordBytes + 4096 }); }
  catch (error) {
    if (!(error instanceof ExtensionHttpError)) throw error;
    if (error.status === 413) throw new StoreError(413, 'record_too_large', 'Request body is too large');
    throw new StoreError(error.status, error.code, bodyMessages[error.code] ?? error.message);
  }
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
  return json(outcome.status, view(record), [...(location === undefined ? [] : [['location', `${location}/${record.id as string}`] as [string, string]]), ...recordHeaders(record, outcome.may), ...replayed]);
}
/**
 * The answer to a transfer (#902): `{from, to?}`, the debited record and, when the caller may read it, the credited
 * one, each as it is now, with the debited record's ETag (the one `If-Match` takes) and whether it was replayed.
 */
function transferred(outcome: Transferred): HandlerResult {
  const replayed: [string, string][] = outcome.replayed ? [['idempotency-replayed', 'true']] : [];
  // A replay after the debited record was deleted: nothing left to answer with, as for any write's replay.
  if (outcome.from === undefined) throw new StoreError(404, 'not_found', 'No such record');
  return json(outcome.status, { from: view(outcome.from), ...(outcome.to === undefined ? {} : { to: view(outcome.to) }) }, [['etag', etagOf(outcome.from)], ...replayed]);
}
/** A transition takes no body: its effect is declared, and the caller supplies only the record, `If-Match` and the key. */
function noBody(request: ExtensionRequest): void {
  if (request.body.byteLength > 0) throw new StoreError(400, 'body_not_allowed', 'A transition takes no request body');
}
async function dispatch(mounts: Mounts, site: Pick<ExtensionActivation, 'origin' | 'origins'>, request: ExtensionRequest): Promise<HandlerResult> {
  const short = request.mount === null ? undefined : mounts.shortByMount.get(request.mount);
  if (short) return dispatchShortLink(short, request);
  const readers = request.mount === null ? undefined : mounts.readersByMount.get(request.mount);
  if (readers) return dispatchReaders(readers, request);
  const transition = request.mount === null ? undefined : mounts.transitionByMount.get(request.mount);
  const collection = transition?.collection ?? (request.mount === null ? undefined : mounts.byMount.get(request.mount));
  if (!collection || request.mount === null) return failure(new StoreError(404, 'not_found', 'No such collection'));
  const rest = request.path.slice(request.mount.length).replace(/^\/+/, '');
  const method = request.method.toUpperCase(), write = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const allowed = (methods: string): [string, string][] => [['allow', methods]];
  const principal = request.principal?.id, actor = principal ?? 'anonymous', viewer = { principal };
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
      return written(collection.transition(rest, transition.name, retryOf(request, retryKey(request, collection)), match, principal, actor, viewer));
    }
    if (rest === '') {
      if (method === 'GET' || method === 'HEAD') return json(200, listView(collection.list(request.query, owner, viewer)));
      if (method === 'POST') {
        const key = retryKey(request, collection), body = bodyOf(request, collection);
        return written(collection.create(body, retryOf(request, key, body), principal, actor, viewer), request.mount);
      }
      return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, POST'));
    }
    const transfer = rest.match(/^transfers\/([a-z][a-z0-9_-]{0,63})$/);
    if (transfer && Object.hasOwn(collection.spec.transfers, transfer[1]!)) {
      if (method !== 'POST') return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('POST'));
      const key = retryKey(request, collection), match = ifMatch(request), body = bodyOf(request, collection);
      return transferred(collection.transfer(transfer[1]!, body, retryOf(request, key, body), match, principal, actor));
    }
    const increment = rest.match(/^([0-9a-f-]{36})\/increment\/([a-z][A-Za-z0-9_]*)$/);
    if (increment && method === 'POST') return written(collection.increment(increment[1]!, increment[2]!, retryOf(request, retryKey(request, collection)), owner, actor, viewer));
    const named = rest.match(/^([0-9a-f-]{36})\/([a-z][a-z0-9_-]{0,63})$/);
    // Only transitions served on the collection mount; a `by: others` one answers only on its own mount.
    if (named && UUID.test(named[1]!) && Object.hasOwn(collection.spec.transitions, named[2]!) && collection.spec.transitions[named[2]!]!.mount === undefined) {
      if (method !== 'POST') return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('POST'));
      noBody(request);
      const match = ifMatch(request);
      return written(collection.transition(named[1]!, named[2]!, retryOf(request, retryKey(request, collection)), match, principal, actor, viewer));
    }
    if (rest.includes('/') || !UUID.test(rest)) throw new StoreError(404, 'not_found', 'No such record');
    if (method === 'GET' || method === 'HEAD') return shownAnswer(collection.show(rest, owner, principal));
    const match = ifMatch(request);
    if (method === 'PUT' || method === 'PATCH') {
      const key = retryKey(request, collection), body = bodyOf(request, collection);
      return written(collection.update(rest, body, method === 'PUT', retryOf(request, key, body), match, owner, actor, viewer));
    }
    if (method === 'DELETE') return written(collection.remove(rest, retryOf(request, retryKey(request, collection)), match, owner, actor));
    return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, PUT, PATCH, DELETE'));
  } catch (error) {
    if (error instanceof StoreError) return failure(error, error.status === 405 ? allowed(transition ? 'POST' : collection.spec.readOnly ? 'GET, HEAD' : 'GET, HEAD, POST, PUT, PATCH, DELETE') : []);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request')); // never echo the cause
  }
}
/**
 * A readers mount (#863, #944): `GET`/`HEAD <mount>` lists and `GET`/`HEAD <mount>/<id>` reads every owner's records
 * for a member of that mount's membership collection (or any principal, on a projection without one). Read-only: every other method is 405. The principal (401) and the
 * membership gate (403) are checked before the path is interpreted or any record is read.
 */
async function dispatchReaders({ collection, name }: ReadersMount, request: ExtensionRequest): Promise<HandlerResult> {
  const rest = request.mount === null ? '' : request.path.slice(request.mount.length).replace(/^\/+/, '');
  const method = request.method.toUpperCase();
  try {
    if (method !== 'GET' && method !== 'HEAD') return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), [['allow', 'GET, HEAD']]);
    const principal = request.principal?.id;
    // With showOwner, and only here, a member sees each record's owner: the opaque principal id, nothing more.
    const readers = collection.spec.readers[name]!;
    const { project, tag } = readers.properties ? projection(readers.properties, readers.showOwner) : { project: (record: StoredRecord): StoredRecord => readers.showOwner ? record : view(record), tag: etagOf };
    if (rest === '') return json(200, listView(collection.listAcross(name, request.query, principal), project, tag));
    return shownAnswer(collection.getAcross(name, rest, principal), project, tag);
  } catch (error) {
    if (error instanceof StoreError) return failure(error);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request'));
  }
}
async function dispatchShortLink(short: ShortLink, request: ExtensionRequest): Promise<HandlerResult> {
  const rest = request.mount === null ? '' : request.path.slice(request.mount.length).replace(/^\/+/, '');
  const method = request.method.toUpperCase();
  try {
    if (!['GET', 'HEAD'].includes(method)) return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), [['allow', 'GET, HEAD']]);
    if (!rest || rest.includes('/')) throw new StoreError(404, 'not_found', 'No such record');
    // HEAD has no side effects: resolve the destination without counting a click. A record whose destination is
    // missing or not redirectable (stored before the short link was declared, since stored rows are judged without
    // `required` and the redirect rule applies to writes) answers 404 without counting rather than a 302 to it.
    const target = short.collection.getByKey(rest);
    if (!redirectable(target[short.destination])) throw new StoreError(404, 'not_found', 'No such record');
    const record = method === 'HEAD' ? target : short.collection.recordClick(target.id as string, short.clicks);
    return { status: 302, headers: [['location', record[short.destination] as string], ['cache-control', 'no-store']] };
  } catch (error) {
    if (error instanceof StoreError) return failure(error);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request'));
  }
}
