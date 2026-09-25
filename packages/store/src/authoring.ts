import type { ExtensionAuthoringContract } from '@jimhoyd/urlcode/extensions';

/** The store's authoring surfaces, in a module of its own so repository tooling can read them without loading the store or its optional peers. */
export const storeAuthoring: ExtensionAuthoringContract = {
  description: 'Declare collections under extensions.store.config.collections and mount each on a route with `extension: store`. Bounded unique keys, numeric increments, idempotency retention and short-link redirects remain store-owned; no handler code is needed.',
  surfaces: [
    { kind: 'configuration', name: 'collections', description: 'Per-collection mount, typed fields (including `format: http-url`), bounded unique `key`, numeric `increments`, durable bounded `idempotency`, maxRecords, maxRecordBytes, pageSize, readOnly, `sortable` / `filterable` field lists, and `ownership: owner` (per-record ownership: each signed-in principal sees and changes only its own records; the mount must be guarded by a principal-providing policy such as `auth: true`) with an optional `maxRecordsPerOwner` (at most maxRecords; a principal at it gets `409 owner_quota_exceeded`), and `audit: true` (every write recorded in the audit log with field names and the principal, never values; needs the audit extension, and writes answer `503 audit_backlog` while 1000 events wait to drain).', path: 'urlcode.yaml' },
    { kind: 'configuration', name: 'shortLinks', description: 'Optional public GET redirect mounts that look up a collection key, use a declared HTTP(S) destination field, and atomically increment a declared counter.', path: 'urlcode.yaml' },
    { kind: 'extension', name: 'mount', description: 'Collection routes `/api/<name>/*` use GET, HEAD, POST, PUT, PATCH, DELETE; short-link routes use GET, HEAD. Add `auth: true` to any private mount; an `ownership: owner` collection requires it (or another principal-providing policy).', path: 'urlcode.yaml' },
    { kind: 'configuration', name: 'screens', description: 'Optional list-and-form screens (`/todos: {collection: todos, title?, columns?}`) for declared collections. The store hands them to the ui extension through contributes.ui; each needs a route `<path>/*` with `extension: ui`, methods GET and HEAD. Ignored when ui is not installed.', path: 'urlcode.yaml' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>', 'urlcode test --project . --host-file <host.mjs> --origin <origin>'],
};
