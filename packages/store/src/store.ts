import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ExtensionAuthoringContract, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { Collection, StoreError, collectionSchema, etagOf } from './collection.ts';
import type { CollectionSpec, StoredRecord } from './collection.ts';
import { screensSchema, storeScreens } from './screens.ts';
/** One value per process start (not per `lock()` call), so a stale lock file written by an
 * earlier process that happened to reuse this PID (routine for a container restarted after an
 * unclean exit, especially at PID 1) can be told apart from a lock this process itself still
 * holds. */
const PROCESS_INSTANCE = randomUUID();

export interface StoreExtensionOptions {
  /** Absolute operator directory that holds the data files. It must be outside the route project and is never created inside it. */
  directory: string;
  /** Exact project revision the operator reviewed (`inspectExtensionRevision`). */
  projectSha256: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD = /^[a-z][A-Za-z0-9_]{0,63}$/;
const json = (status: number, value: unknown, extra: [string, string][] = []): HandlerResult => ({
  status, headers: [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'], ...extra], body: JSON.stringify(value),
});
const failure = (error: StoreError, extra: [string, string][] = []): HandlerResult =>
  json(error.status, { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }, extra);
const view = (record: StoredRecord): StoredRecord => record;

/** Resolves symlinks through the deepest ancestor that exists, so a not-yet-created directory compares correctly. */
async function realTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { const parent = dirname(path); return parent === path ? path : join(await realTarget(parent), basename(path)); }
}

/**
 * Removes an operator directory lock left by a process that no longer exists; refuses one held by
 * a live process. The lock file holds `<pid>:<processInstance>`; a file bearing our own PID but a
 * different (or absent) instance was written by an earlier process that has since exited and whose
 * PID our process has now reused (common for a container restarted after an unclean exit — PID 1
 * especially), so it is treated as stale rather than as proof this process already holds it.
 * The claim itself is atomic: content is written to a uniquely-named temporary file first, then
 * linked into place — `link()` fails with EEXIST if the destination already exists — so no other
 * process can ever observe (or race the creation of) an empty or partially written lock file, the
 * gap `open(path, 'wx')` followed by a separate `writeFile` left open.
 *
 * Reclaiming a stale lock is also guarded (#549): the file judged stale is first atomically
 * renamed to a unique name and its contents re-read there. Only if they still equal what was
 * judged stale is it removed; otherwise another process reclaimed the lock between our read and
 * our rename, so its fresh lock is linked back into place and this process refuses to start rather
 * than deleting it. Unlock likewise removes the lock file only while it still carries this lock's
 * own `<pid>:<instance>` identity.
 *
 * `hooks.beforeReclaim` is a test seam only: it runs after a lock has been judged stale and
 * before the reclaim, so a test can deterministically inject a concurrent reclaim.
 */
export async function lockStoreDirectory(directory: string, hooks: { beforeReclaim?: () => Promise<void> } = {}): Promise<() => Promise<void>> {
  const path = join(directory, '.store.lock'), identity = `${process.pid}:${PROCESS_INSTANCE}`;
  const code = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = join(directory, `.store.lock.${randomUUID()}.tmp`);
    let claimed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(identity); await handle.sync(); } finally { await handle.close(); }
      await link(temporary, path);
      claimed = true;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    if (claimed) return async () => {
      // Only ever remove a lock this call still owns: never one another process has since claimed.
      if ((await readFile(path, 'utf8').catch(() => '')) === identity) await rm(path, { force: true });
    };
    const observed = await readFile(path, 'utf8').catch(() => '');
    const [pidPart, instancePart] = observed.trim().split(':');
    const pid = Number(pidPart);
    let stale = false;
    if (Number.isInteger(pid) && pid > 0) {
      if (pid === process.pid) {
        // A legacy lock file (written before this fix) carries no instance id: treated
        // cautiously, as this process already holding it, exactly like before.
        if (instancePart === undefined || instancePart === PROCESS_INSTANCE) throw new Error('Store directory is already locked by this process');
        stale = true;
      } else {
        try { process.kill(pid, 0); } catch (e) { stale = code(e) === 'ESRCH'; }
      }
    } else stale = true; // unreadable or malformed lock file content
    if (!stale) throw new Error('Store directory is in use by another process; the file store supports one writer');
    await hooks.beforeReclaim?.();
    const reclaimed = join(directory, `.store.lock.${randomUUID()}.stale`);
    try { await rename(path, reclaimed); }
    catch (error) { if (code(error) === 'ENOENT') continue; throw error; } // already reclaimed: retry the claim
    const moved = await readFile(reclaimed, 'utf8').catch(() => '');
    if (moved === observed) { await rm(reclaimed, { force: true }); continue; }
    // Another process replaced the stale lock with its own between our read and our rename: put
    // its fresh lock back and refuse, rather than deleting it and letting two writers proceed.
    try { await link(reclaimed, path); }
    finally { await rm(reclaimed, { force: true }); }
    throw new Error('Store directory is in use by another process; the file store supports one writer');
  }
  throw new Error('Store directory cannot be locked');
}

export const storeAuthoring: ExtensionAuthoringContract = {
  description: 'Declare collections under extensions.store.config.collections and mount each on a route with `extension: store`. Bounded unique keys, numeric increments, idempotency retention and short-link redirects remain store-owned; no handler code is needed.',
  surfaces: [
    { kind: 'configuration', name: 'collections', description: 'Per-collection mount, typed fields (including `format: http-url`), bounded unique `key`, numeric `increments`, durable bounded `idempotency`, maxRecords, maxRecordBytes, pageSize, readOnly, and `sortable` / `filterable` field lists.', path: 'urlcode.yaml' },
    { kind: 'configuration', name: 'shortLinks', description: 'Optional public GET redirect mounts that look up a collection key, use a declared HTTP(S) destination field, and atomically increment a declared counter.', path: 'urlcode.yaml' },
    { kind: 'extension', name: 'mount', description: 'Collection routes `/api/<name>/*` use GET, HEAD, POST, PUT, PATCH, DELETE; short-link routes use GET, HEAD. Add `auth: true` to any private mount.', path: 'urlcode.yaml' },
    { kind: 'configuration', name: 'screens', description: 'Optional list-and-form screens (`/todos: {collection: todos, title?, columns?}`) for declared collections. The store hands them to the ui extension through contributes.ui; each needs a route `<path>/*` with `extension: ui`, methods GET and HEAD. Ignored when ui is not installed.', path: 'urlcode.yaml' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>', 'urlcode test --project . --host-file <host.mjs> --origin <origin>'],
};

/** The `extensions.store.config` schema: the registration and the extension definition share this one object. */
export const storeConfigSchema = { type: 'object', additionalProperties: false, required: ['collections'], properties: {
  collections: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: NAME.source }, additionalProperties: collectionSchema },
  shortLinks: { type: 'object', maxProperties: 32, propertyNames: { pattern: NAME.source }, additionalProperties: {
    type: 'object', additionalProperties: false, required: ['mount', 'collection', 'destination', 'clicks'], properties: {
      mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 }, collection: { type: 'string', pattern: NAME.source },
      destination: { type: 'string', pattern: FIELD.source }, clicks: { type: 'string', pattern: FIELD.source },
    },
  } },
  screens: screensSchema,
} };

/** The operator-installed registration. Storage location and the revision pin are operator choices, never project YAML. */
export function storeExtension(options: StoreExtensionOptions): RuntimeExtension {
  if (!isAbsolute(options.directory)) throw new Error('Store directory must be an absolute path');
  return {
    name: 'store', version: '1', projectSha256: options.projectSha256, targets: ['node'],
    schema: storeConfigSchema,
    authoring: storeAuthoring,
    async activate(config, context): Promise<ExtensionInstance> {
      const directory = resolve(options.directory), rel = relative(await realTarget(resolve(context.root)), await realTarget(directory));
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Store directory must be outside the route project');
      const declared = (config as { collections: Record<string, CollectionSpec>; shortLinks?: Record<string, ShortLinkSpec> }).collections;
      const declaredLinks = (config as { shortLinks?: Record<string, ShortLinkSpec> }).shortLinks ?? {};
      // Screens are served by ui, but they name store collections, so an unknown one refuses here too.
      storeScreens(config);
      const byMount = new Map<string, Collection>();
      const collections = Object.entries(declared).map(([name, spec]) => new Collection(name, spec, directory));
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
      for (const mount of context.mounts) if (!byMount.has(mount) && !shortByMount.has(mount)) throw new Error(`Mount ${mount} has no collection or short link declared`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await stat(directory)).isDirectory()) throw new Error('Store directory is not a directory');
      const unlock = await lockStoreDirectory(directory);
      try { for (const collection of collections) await collection.load(); }
      catch (error) { await unlock(); throw error; }
      return {
        handle: request => dispatch(byMount, shortByMount, context.origin, request),
        async close() { await unlock(); },
      };
    },
  };
}

interface ShortLinkSpec { mount: string; collection: string; destination: string; clicks: string }
interface ShortLink { collection: Collection; destination: string; clicks: string }

function bodyOf(request: ExtensionRequest, collection: Collection): unknown {
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new StoreError(415, 'unsupported_media_type', 'Send Content-Type: application/json');
  if (request.body.byteLength > collection.spec.maxRecordBytes + 4096) throw new StoreError(413, 'record_too_large', 'Request body is too large');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)); }
  catch { throw new StoreError(400, 'invalid_json', 'Body is not valid JSON'); }
}
/**
 * Scoped by caller: the header's raw value is hashed together with `request.client` (the
 * network client the runtime attributes the request to, or a fixed marker when unknown) into one
 * fixed-length opaque key, so two callers who happen to choose the same `Idempotency-Key` string
 * cannot collide — one could otherwise be served the other's cached response. An unauthenticated
 * mount has no stronger caller identity than the network client to scope by; document that limit
 * where the mount is declared, not here.
 */
function idempotencyKey(request: ExtensionRequest): string | undefined {
  const key = request.headers.get('idempotency-key');
  if (key === null) return undefined;
  if ((request.headerCounts['idempotency-key'] ?? 1) !== 1 || key.length < 1 || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) throw new StoreError(400, 'invalid_idempotency_key', 'Idempotency-Key must be one header value no longer than 128 characters');
  return createHash('sha256').update(`${request.client ?? '<unknown>'}\u0000${key}`).digest('hex');
}
/** A bare `If-Match` value (this store never emits a weak or list-form ETag, so it only accepts
 * exactly one strong quoted value); `undefined` for an absent header, `null` for a malformed one. */
function ifMatch(request: ExtensionRequest): string | undefined | null {
  const value = request.headers.get('if-match');
  if (value === null) return undefined;
  if ((request.headerCounts['if-match'] ?? 1) !== 1 || !/^"[0-9a-f]{32}"$/.test(value)) return null;
  return value;
}
async function dispatch(byMount: Map<string, Collection>, shortByMount: Map<string, ShortLink>, origin: string, request: ExtensionRequest): Promise<HandlerResult> {
  const short = request.mount === null ? undefined : shortByMount.get(request.mount);
  if (short) return dispatchShortLink(short, request);
  const collection = request.mount === null ? undefined : byMount.get(request.mount);
  if (!collection || request.mount === null) return failure(new StoreError(404, 'not_found', 'No such collection'));
  const rest = request.path.slice(request.mount.length).replace(/^\/+/, '');
  const method = request.method.toUpperCase(), write = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const allowed = (methods: string): [string, string][] => [['allow', methods]];
  try {
    // A JSON-only write API is not reachable by a cross-site form; a browser also sends Origin on cross-site writes, which must match.
    const from = request.headers.get('origin');
    if (write && from !== null && from !== origin) throw new StoreError(403, 'forbidden_origin', 'Cross-origin writes are refused');
    if (rest === '') {
      if (method === 'GET' || method === 'HEAD') {
        return json(200, collection.list(request.query));
      }
      if (method === 'POST') { const key = idempotencyKey(request); collection.validateIdempotency(key); const record = await collection.create(bodyOf(request, collection), key); return json(201, view(record), [['location', `${request.mount}/${record.id as string}`], ['etag', etagOf(record)]]); }
      return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, POST'));
    }
    const increment = rest.match(/^([0-9a-f-]{36})\/increment\/([a-z][A-Za-z0-9_]*)$/);
    if (increment && method === 'POST') return json(200, view(await collection.increment(increment[1]!, increment[2]!, idempotencyKey(request))));
    if (rest.includes('/') || !UUID.test(rest)) throw new StoreError(404, 'not_found', 'No such record');
    if (method === 'GET' || method === 'HEAD') { const record = collection.get(rest); return json(200, view(record), [['etag', etagOf(record)]]); }
    const match = ifMatch(request);
    if (match === null) throw new StoreError(400, 'invalid_if_match', 'If-Match must be one strong quoted ETag this store issued');
    if (method === 'PUT') { const key = idempotencyKey(request); collection.validateIdempotency(key); const record = await collection.update(rest, bodyOf(request, collection), true, key, match); return json(200, view(record), [['etag', etagOf(record)]]); }
    if (method === 'PATCH') { const key = idempotencyKey(request); collection.validateIdempotency(key); const record = await collection.update(rest, bodyOf(request, collection), false, key, match); return json(200, view(record), [['etag', etagOf(record)]]); }
    if (method === 'DELETE') { await collection.remove(rest, idempotencyKey(request), match); return { status: 204, headers: [['cache-control', 'no-store']] }; }
    return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, PUT, PATCH, DELETE'));
  } catch (error) {
    if (error instanceof StoreError) return failure(error, error.status === 405 ? allowed(collection.spec.readOnly ? 'GET, HEAD' : 'GET, HEAD, POST, PUT, PATCH, DELETE') : []);
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
    const record = method === 'HEAD' ? target : await short.collection.recordClick(target.id as string, short.clicks);
    return { status: 302, headers: [['location', record[short.destination] as string], ['cache-control', 'no-store']] };
  } catch (error) {
    if (error instanceof StoreError) return failure(error);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request'));
  }
}
