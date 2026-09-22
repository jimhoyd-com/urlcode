import { mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ExtensionAuthoringContract, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { Collection, StoreError, collectionSchema } from './collection.ts';
import type { CollectionSpec, StoredRecord } from './collection.ts';

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

/** Removes an operator directory lock left by a process that no longer exists; refuses one held by a live process. */
async function lock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, '.store.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    let held: boolean;
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) { held = error instanceof Error && 'code' in error && error.code === 'EEXIST'; }
    if (!held) break;
    const pid = Number((await readFile(path, 'utf8').catch(() => '')).trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = !(e instanceof Error && 'code' in e && e.code === 'ESRCH'); } }
    // A pid this process holds itself counts as live: a second store over one directory in one process is the same hazard.
    if (alive) throw new Error('Store directory is in use by another process; the file store supports one writer');
    await rm(path, { force: true });
  }
  throw new Error('Store directory cannot be locked');
}

export const storeAuthoring: ExtensionAuthoringContract = {
  description: 'Declare collections under extensions.store.config.collections and mount each on a route with `extension: store`. Bounded unique keys, numeric increments, idempotency retention and short-link redirects remain store-owned; no handler code is needed.',
  surfaces: [
    { kind: 'configuration', name: 'collections', description: 'Per-collection mount, typed fields (including `format: http-url`), bounded unique `key`, numeric `increments`, durable bounded `idempotency`, maxRecords, maxRecordBytes, pageSize, readOnly, and `sortable` / `filterable` field lists.', path: 'urlcode.yaml' },
    { kind: 'configuration', name: 'shortLinks', description: 'Optional public GET redirect mounts that look up a collection key, use a declared HTTP(S) destination field, and atomically increment a declared counter.', path: 'urlcode.yaml' },
    { kind: 'extension', name: 'mount', description: 'Collection routes `/api/<name>/*` use GET, HEAD, POST, PUT, PATCH, DELETE; short-link routes use GET, HEAD. Add `auth: true` to any private mount.', path: 'urlcode.yaml' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>', 'urlcode test --project . --host-file <host.mjs> --origin <origin>'],
};

/** The operator-installed registration. Storage location and the revision pin are operator choices, never project YAML. */
export function storeExtension(options: StoreExtensionOptions): RuntimeExtension {
  if (!isAbsolute(options.directory)) throw new Error('Store directory must be an absolute path');
  return {
    name: 'store', version: '1', projectSha256: options.projectSha256, targets: ['node'],
    schema: { type: 'object', additionalProperties: false, required: ['collections'], properties: {
      collections: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: NAME.source }, additionalProperties: collectionSchema },
      shortLinks: { type: 'object', maxProperties: 32, propertyNames: { pattern: NAME.source }, additionalProperties: {
        type: 'object', additionalProperties: false, required: ['mount', 'collection', 'destination', 'clicks'], properties: {
          mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 }, collection: { type: 'string', pattern: NAME.source },
          destination: { type: 'string', pattern: FIELD.source }, clicks: { type: 'string', pattern: FIELD.source },
        },
      } },
    } },
    authoring: storeAuthoring,
    async activate(config, context): Promise<ExtensionInstance> {
      const directory = resolve(options.directory), rel = relative(await realTarget(resolve(context.root)), await realTarget(directory));
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Store directory must be outside the route project');
      const declared = (config as { collections: Record<string, CollectionSpec>; shortLinks?: Record<string, ShortLinkSpec> }).collections;
      const declaredLinks = (config as { shortLinks?: Record<string, ShortLinkSpec> }).shortLinks ?? {};
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
        if (!destination || destination.type !== 'string' || destination.format !== 'http-url') throw new Error(`Short link ${name}: destination must name a string field with format http-url`);
        if (!collection.spec.increments.includes(link.clicks)) throw new Error(`Short link ${name}: clicks must name a declared increment field`);
        if (byMount.has(link.mount) || shortByMount.has(link.mount)) throw new Error(`Short link ${name}: mount ${link.mount} conflicts with a collection or short link mount`);
        if (!context.mounts.includes(link.mount)) throw new Error(`Short link ${name}: route ${link.mount}/* with extension: store is not declared`);
        shortByMount.set(link.mount, { collection, destination: link.destination, clicks: link.clicks });
      }
      for (const collection of collections) if (!context.mounts.includes(collection.spec.mount)) throw new Error(`Collection ${collection.name}: route ${collection.spec.mount}/* with extension: store is not declared`);
      for (const mount of context.mounts) if (!byMount.has(mount) && !shortByMount.has(mount)) throw new Error(`Mount ${mount} has no collection or short link declared`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await stat(directory)).isDirectory()) throw new Error('Store directory is not a directory');
      const unlock = await lock(directory);
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
function idempotencyKey(request: ExtensionRequest): string | undefined {
  const key = request.headers.get('idempotency-key');
  if (key === null) return undefined;
  if ((request.headerCounts['idempotency-key'] ?? 1) !== 1 || key.length < 1 || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) throw new StoreError(400, 'invalid_idempotency_key', 'Idempotency-Key must be one header value no longer than 128 characters');
  return key;
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
      if (method === 'POST') { const key = idempotencyKey(request); collection.validateIdempotency(key); const record = await collection.create(bodyOf(request, collection), key); return json(201, view(record), [['location', `${request.mount}/${record.id as string}`]]); }
      return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, POST'));
    }
    const increment = rest.match(/^([0-9a-f-]{36})\/increment\/([a-z][A-Za-z0-9_]*)$/);
    if (increment && method === 'POST') return json(200, view(await collection.increment(increment[1]!, increment[2]!, idempotencyKey(request))));
    if (rest.includes('/') || !UUID.test(rest)) throw new StoreError(404, 'not_found', 'No such record');
    if (method === 'GET' || method === 'HEAD') return json(200, view(collection.get(rest)));
    if (method === 'PUT') { const key = idempotencyKey(request); collection.validateIdempotency(key); return json(200, view(await collection.update(rest, bodyOf(request, collection), true, key))); }
    if (method === 'PATCH') { const key = idempotencyKey(request); collection.validateIdempotency(key); return json(200, view(await collection.update(rest, bodyOf(request, collection), false, key))); }
    if (method === 'DELETE') { await collection.remove(rest, idempotencyKey(request)); return { status: 204, headers: [['cache-control', 'no-store']] }; }
    return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), allowed('GET, HEAD, PUT, PATCH, DELETE'));
  } catch (error) {
    if (error instanceof StoreError) return failure(error, error.status === 405 ? allowed(collection.spec.readOnly ? 'GET, HEAD' : 'GET, HEAD, POST, PUT, PATCH, DELETE') : []);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request')); // never echo the cause
  }
}
async function dispatchShortLink(short: ShortLink, request: ExtensionRequest): Promise<HandlerResult> {
  const rest = request.mount === null ? '' : request.path.slice(request.mount.length).replace(/^\/+/, '');
  try {
    if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) return failure(new StoreError(405, 'method_not_allowed', 'Method not allowed'), [['allow', 'GET, HEAD']]);
    if (!rest || rest.includes('/')) throw new StoreError(404, 'not_found', 'No such record');
    const record = await short.collection.increment(short.collection.getByKey(rest).id as string, short.clicks);
    return { status: 302, headers: [['location', record[short.destination] as string], ['cache-control', 'no-store']] };
  } catch (error) {
    if (error instanceof StoreError) return failure(error);
    return failure(new StoreError(500, 'internal_error', 'The store failed to handle this request'));
  }
}
