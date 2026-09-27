# @jimhoyd/urlcode-store

Operator-installed data store extension for URLCode. Declare typed collections in
`urlcode.yaml`, mount each with `extension: store`, and the extension serves a
bounded JSON CRUD API backed by atomically written files in an operator-owned
directory. No handler code.

## Install

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with ui,auth,store --example
# or, in an existing site:
npx urlcode extensions add store --example
```

Without `--example` the store installs as a capability only: an empty
`collections` block in `app/urlcode.yaml`, no mount and no acknowledgement.
Declare your own collection and its `extension: store` route there.

`store` is released as a tarball on core's GitHub Release, at core's version,
and pinned by sha512 in core's `dist/addons.json`; `urlcode extensions add`
installs it into the site and checks that pin. See
[add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts) for the
site layout and commands.

`--example` declares a `todos` collection in `app/urlcode.yaml` and mounts it at
`/api/todos/*` in `app/routes/store.yaml`. Either way `add` adds one line to `host.mjs`:

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [
  store(),                    // or store({ directory: '/var/lib/site/store' })
]);
```

Collection files live in `store({ directory })`, else `STORE_DIRECTORY`, else
`data/store` beside `host.mjs`; the directory must be outside `app/`.

When `ui` is installed too, the example also declares a `/todos` list-and-form
screen under `extensions.store.config.screens` and its `/todos/*` route with
`extension: ui` (signed-in only when `auth` is installed). The store owns that
screen: it declares it next to the collection, and hands ui a generic
description of it through its definition's optional `contributes.ui.screens`,
so ui never reads the store's configuration. `ui` is an optional peer, not a
requirement: without it `screens` is simply not served. See
[a screen for the collection](../../docs/STORE.md#a-screen-for-the-collection).

When `auth` is installed the example puts `auth: {csrf: origin}` on the API
mount (auth admits its JSON writes on same-origin provenance and the session
cookie; the store accepts only JSON) and declares the `todos` collection
`ownership: owner`, so each signed-in user sees and changes only their own
todos. Auth installs `audit`, so the example collection also declares
`audit: true`. Without
`auth` the example refuses; the refusal prints the exact command, ending in
`--ack store:public-write`, which acknowledges a public writable endpoint (not
rate limiting, abuse protection or multi-tenant isolation).

The full guide, HTTP contract, limits and the honest list of concurrency
guarantees is [docs/STORE.md](https://github.com/jimhoyd-com/urlcode/blob/main/docs/STORE.md).
Short version: one server process per directory (enforced by a lock file,
which a `urlcode dev` hot reload shares with the replacement runtime through
core's reload hand-off rather than taking twice; see
[single-writer lock and reload](../../docs/STORE.md#single-writer-lock-and-reload)),
whole-file atomic writes, per-collection record and byte quotas, last write
wins, no transactions. A collection is shared by default; one that holds
per-user data declares `ownership: owner`, and every request is then scoped to
the principal a policy such as `auth: true` on its mount sets (another user's
record is a `404`, records written before it became owned are served to nobody
until `urlcode-store ownerless-assign` or `ownerless-delete` handles them,
`urlcode-store reassign --from <principal> --to <principal>` moves one
principal's records to another with the server stopped, and
`maxRecordsPerOwner` caps each user's records with `409 owner_quota_exceeded`; see
[per-record ownership](../../docs/STORE.md#per-record-ownership)). A collection may declare
`sortable` and `filterable` field lists for `?sort=<field>` / `?sort=-<field>`
and `?<field>=<value>` list queries (one sort field, equality filters, `id`
tie-break, opaque cursor, undeclared names are `400`s); they apply to the whole
collection, or on an owned collection to the caller's own records. A `PATCH`
that sets a field to `null` removes it; a required field refuses that with a
`400` field error, and `PUT` still takes only values (see
[clearing a field](../../docs/STORE.md#clearing-a-field)).

A collection that declares `audit: true` records every write in the audit
log (the store `uses` the `audit` extension; activation refuses such a
collection when audit is not installed, or when no principal-providing policy
guards its mount). Each create, replace, update, delete and increment (never a
short-link click) is an event (`store.record.created`, `.replaced`, `.updated`,
`.deleted`, `.incremented`) with subject `<collection>/<id>`, the principal id
or `anonymous` as actor, and the changed field names, never values. The event
is written into the collection's data file (its `audit` array) in the same
write as the record and drained by audit while the host runs; when 1000 events
wait undelivered the next write answers `503 audit_backlog` and changes
nothing. See [audited writes](../../docs/STORE.md#audited-writes).

Another extension that requires the store reaches declared collections through
its typed export, `StoreExports` (`ctx.get('store')`): `create`, `get`, a
partial `update` (which clears a field given `null`, like `PATCH`) and a
paginated `list`, each scoped to the request principal exactly as the JSON API
is. See [using a collection from another extension](../../docs/STORE.md#using-a-collection-from-another-extension).

## Short links

A collection with a unique `key`, a required `format: http-url` destination
field and one `increments` counter can back public short links with no
function: `shortLinks.<name>` names that collection, its destination and click
fields, and a redirect mount separate from the CRUD mount. `GET /go/<code>`
counts the click and answers `302` to the stored destination; `HEAD` answers the
same without counting; an unknown code is `404`.

```yaml
version: "1"
extensions:
  store:
    version: "1"
    config:
      collections:
        links:
          mount: /api/links
          key: code
          increments: [clicks]
          fields:
            code: {type: string, required: true, minLength: 1, maxLength: 32}
            destination: {type: string, required: true, format: http-url, maxLength: 2048}
            clicks: {type: integer, default: 0, minimum: 0}
      shortLinks:
        public: {mount: /go, collection: links, destination: destination, clicks: clicks}
routes:
  /api/links/*: {extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true}
  /go/*: {extension: store, methods: [GET, HEAD]}
```

Protect the CRUD mount according to who may create links (`auth: true` above
needs the auth extension). [Bounded keyed transitions](../../docs/STORE.md#bounded-keyed-transitions)
has the full rules for `key`, `increments` and `idempotency`; the
[field reference](#field-reference) below lists every `shortLinks` key.

## Store schema artifact

The `store-schema` artifact (`urlcode artifacts add store-schema`) carries this
extension's configuration schema and an example configuration as inert JSON
for authoring tools; it does not register `store` or grant access to a data
directory. See [artifacts](../../docs/EXTENSIONS.md#artifacts).

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `store` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** uses `audit` when installed (optional: the features that need one refuse to activate without it); contributes to `ui` (read only when that extension is installed).

### Configuration: `extensions.store.config`

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.store.config.collections` | object | yes | maxProperties: 32; keys: "^[a-z][a-z0-9_-]{0,63}$" | File-backed JSON collections by name, each stored as `data/store/<name>.json` (outside app/) and served as a bounded CRUD API at its mount. |
| `extensions.store.config.collections.*.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | URL path of the collection's JSON API; it needs a route `<mount>/*` with extension: store (GET, HEAD, POST, PUT, PATCH, DELETE). |
| `extensions.store.config.collections.*.fields` | object | yes | minProperties: 1; maxProperties: 64; keys: "^[a-z][A-Za-z0-9_]{0,63}$" | Declared record fields by name; a body naming any other field is refused. id, createdAt and updatedAt are reserved and store-owned. |
| `extensions.store.config.collections.*.fields.*.type` | string | yes | enum: ["string","integer","number","boolean"] | Value type; integer must be a safe integer and number a finite number. |
| `extensions.store.config.collections.*.fields.*.required` | boolean | no | — | true: every record must carry the field and PATCH cannot clear it; not combinable with default. |
| `extensions.store.config.collections.*.fields.*.default` | string / number / boolean | no | one of: string (maxLength: 65536); number; boolean | Value stored on create when the body omits the field; it must satisfy the field's own rules. |
| `extensions.store.config.collections.*.fields.*.minLength` | integer | no | minimum: 0; maximum: 65536 | Fewest characters of a string value. |
| `extensions.store.config.collections.*.fields.*.maxLength` | integer | no | minimum: 1; maximum: 65536 | Most characters of a string value (default 65536); a key needs at most 128, and a sortable or filterable string field a small bound or an enum. |
| `extensions.store.config.collections.*.fields.*.format` | string | no | enum: ["http-url"] | http-url: the string must be an absolute HTTP(S) URL without credentials or ASCII whitespace; required for a short-link destination. |
| `extensions.store.config.collections.*.fields.*.enum` | array | no | minItems: 1; maxItems: 64; items: string / number (one of: string (maxLength: 256); number) | The only values the field accepts; not for booleans. |
| `extensions.store.config.collections.*.fields.*.minimum` | number | no | — | Smallest numeric value; numbers only. |
| `extensions.store.config.collections.*.fields.*.maximum` | number | no | — | Largest numeric value; numbers only. |
| `extensions.store.config.collections.*.maxRecords` | integer | no | minimum: 1; maximum: 10000 | Records the collection may hold (default 1000); a create beyond it answers 409 collection_full. |
| `extensions.store.config.collections.*.maxRecordBytes` | integer | no | minimum: 256; maximum: 65536 | Largest serialized record in bytes (default 4096); larger answers 413. |
| `extensions.store.config.collections.*.pageSize` | integer | no | minimum: 1; maximum: 200 | Records per list page, and the cap on a list request's limit (default 50). |
| `extensions.store.config.collections.*.readOnly` | boolean | no | — | true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works. |
| `extensions.store.config.collections.*.key` | string | no | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string field (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner. |
| `extensions.store.config.collections.*.increments` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Numeric fields with a numeric default that POST `<mount>/<id>/increment/<field>` raises by exactly one under the write lock, within the field's bounds. |
| `extensions.store.config.collections.*.idempotency` | object | no | unknown keys rejected | Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE and increment; a repeated retained key answers 409 idempotency_duplicate. Without it the header answers 400 idempotency_not_enabled. |
| `extensions.store.config.collections.*.idempotency.maxKeys` | integer | yes | minimum: 1; maximum: 1000 | Newest distinct keys retained, per network client; an evicted key is no longer protected. |
| `extensions.store.config.collections.*.sortable` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared fields a list request may sort by (sort=`<field>` or sort=`-<field>`). |
| `extensions.store.config.collections.*.filterable` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared fields a list request may filter by equality (`<field>`=`<value>`); limit, cursor and sort cannot be filterable. |
| `extensions.store.config.collections.*.ownership` | string | no | enum: ["shared","owner"] | shared (default): every caller who reaches the mount sees every record. owner: each record belongs to the principal that created it, and every read and write is scoped to it; the mount must carry a principal-providing policy such as auth: true. |
| `extensions.store.config.collections.*.maxRecordsPerOwner` | integer | no | minimum: 1; maximum: 10000 | With ownership: owner only: records one principal may hold, at most maxRecords; beyond it a create answers 409 owner_quota_exceeded. |
| `extensions.store.config.collections.*.audit` | boolean | no | — | true: every write is recorded in the audit log (field names and the principal, never values). Needs the audit extension; writes answer 503 audit_backlog while 1000 events wait to drain. |
| `extensions.store.config.shortLinks` | object | no | maxProperties: 32; keys: "^[a-z][a-z0-9_-]{0,63}$" | Public redirect mounts by name: GET `<mount>/<key>` atomically increments a counter and answers 302 to the record's stored destination; HEAD answers the same 302 without counting; an unknown key is 404. Each needs a route `<mount>/*` with extension: store (GET, HEAD). |
| `extensions.store.config.shortLinks.*.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | URL path of the redirect mount, separate from the collection's CRUD mount. |
| `extensions.store.config.shortLinks.*.collection` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A declared shared collection with a key; the key value is the path segment after the mount. |
| `extensions.store.config.shortLinks.*.destination` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string field with format: http-url holding the redirect target; activation refuses it otherwise. |
| `extensions.store.config.shortLinks.*.clicks` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A field listed in the collection's increments, raised by one on each GET (even when the collection is readOnly). |
| `extensions.store.config.screens` | object | no | maxProperties: 16; keys: "^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$" | List-and-form screens by exact page path, each for one declared collection. The store hands them to ui through contributes.ui; each needs a route `<path>/*` with extension: ui (GET, HEAD). Ignored when ui is not installed. |
| `extensions.store.config.screens.*.collection` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A collection declared under collections; activation fails otherwise. |
| `extensions.store.config.screens.*.title` | string | no | minLength: 1; maxLength: 80 | Page title. Default: the collection name in sentence case. |
| `extensions.store.config.screens.*.columns` | array | no | minItems: 1; maxItems: 64 | Fields shown in the list, in order: a field name, or {field, label} to set the heading. Default: every declared field. Unless the collection is readOnly, every required field without a default must be listed, or ui refuses the screen. |
| `extensions.store.config.screens.*.columns[].field` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A declared field of the collection. |
| `extensions.store.config.screens.*.columns[].label` | string | no | minLength: 1; maxLength: 80 | Column heading. Default: the field name. |

### Authoring surfaces and limits

Declare collections under extensions.store.config.collections and mount each on a route with `extension: store`. Bounded unique keys, numeric increments, idempotency retention and short-link redirects remain store-owned; no handler code is needed.

- **collections** (configuration, `urlcode.yaml`): Per-collection mount, typed fields (including `format: http-url`), bounded unique `key`, numeric `increments`, durable bounded `idempotency`, maxRecords, maxRecordBytes, pageSize, readOnly, `sortable` / `filterable` field lists, and `ownership: owner` (per-record ownership: each signed-in principal sees and changes only its own records; the mount must be guarded by a principal-providing policy such as `auth: true`) with an optional `maxRecordsPerOwner` (at most maxRecords; a principal at it gets `409 owner_quota_exceeded`), and `audit: true` (every write recorded in the audit log with field names and the principal, never values; needs the audit extension, and writes answer `503 audit_backlog` while 1000 events wait to drain).
- **shortLinks** (configuration, `urlcode.yaml`): Optional public GET redirect mounts that look up a collection key, use a declared HTTP(S) destination field, and atomically increment a declared counter.
- **mount** (extension, `urlcode.yaml`): Collection routes `/api/<name>/*` use GET, HEAD, POST, PUT, PATCH, DELETE; short-link routes use GET, HEAD. Add `auth: true` to any private mount; an `ownership: owner` collection requires it (or another principal-providing policy).
- **screens** (configuration, `urlcode.yaml`): Optional list-and-form screens (`/todos: {collection: todos, title?, columns?}`) for declared collections. The store hands them to the ui extension through contributes.ui; each needs a route `<path>/*` with `extension: ui`, methods GET and HEAD. Ignored when ui is not installed.

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
