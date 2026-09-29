# @jimhoyd/urlcode-store

Operator-installed data store extension for URLCode. Declare typed collections in
`urlcode.yaml`, mount each with `extension: store`, and the extension serves a
bounded JSON CRUD API backed by one operator-owned SQLite database. No handler
code.

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
  store(),                    // or store({ database: '/var/lib/site/store.sqlite' })
]);
```

Every collection lives in one SQLite database (`node:sqlite`, so Node only):
`store({ database })`, else `STORE_DATABASE`, else `data/store.sqlite` beside
`host.mjs`; it must be outside `app/`.

When `ui` is installed too, the example also declares a `/todos` list-and-form
screen under `extensions.store.config.screens` and its `/todos/*` route with
`extension: ui` (signed-in only when `auth` is installed). The store owns that
screen: it declares it next to the collection, and hands ui a generic
description of it through its definition's optional `contributes.ui.screens`,
so ui never reads the store's configuration. `ui` is an optional peer, not a
requirement: without it `screens` is simply not served. See
[a screen for the collection](../../docs/STORE.md#a-screen-for-the-collection).

When `auth` is installed the example puts `auth: true` on the API mount (a
signed-in session, and same-origin provenance for writes) and declares the
`todos` collection `ownership: owner`, so each signed-in user sees and changes
only their own todos. When `audit` is installed the example collection also
declares `audit: true`. Without `auth` the example refuses; the refusal prints the exact command, ending in
`--ack store:public-write`, which acknowledges a public writable endpoint (not
rate limiting, abuse protection or multi-tenant isolation).

The full guide, HTTP contract, limits and the honest list of concurrency
guarantees is [docs/STORE.md](https://github.com/jimhoyd-com/urlcode/blob/main/docs/STORE.md).
Short version: one server process per database (supported and tested, not
enforced: SQLite's locks keep another process from corrupting it, and a write
blocked past the 2-second busy timeout answers `503`); every write is one SQLite
transaction that commits the record, its key, its `Idempotency-Key` claim and
its audit event together or not at all; a retried `Idempotency-Key` replays the
first status with the current record (a different request under it is `422`);
per-collection record and byte quotas; last write wins unless a caller sends
`If-Match`; each HTTP request changes one record. A `urlcode dev` hot reload shares the database connection with the
replacement runtime (see [reload](../../docs/STORE.md#reload)). A collection is shared by default; one that holds
per-user data declares `ownership: owner`, and every request is then scoped to
the principal a policy such as `auth: true` on its mount sets (another user's
record is a `404`, records written before it became owned are served to nobody
until `urlcode-store ownerless-assign` or `ownerless-delete` handles them,
`urlcode-store reassign --from <principal> --to <principal>` moves one
principal's records to another in one transaction (on an `audit: true`
collection every moved or deleted record is recorded, with the operator's
optional `--actor`), and
`maxRecordsPerOwner` caps each user's records with `409 owner_quota_exceeded`; see
[per-record ownership](../../docs/STORE.md#per-record-ownership)). A collection may declare
`sortable` and `filterable` field lists for `?sort=<field>` / `?sort=-<field>`
and `?<field>=<value>` list queries (one sort field, equality filters, `id`
tie-break, opaque cursor; undeclared names, unparseable values and values
the field can never hold (outside its `enum`, `minimum`/`maximum`,
`minLength`/`maxLength` or `format`) are `400`s); they apply to the whole
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
is inserted into the store database's outbox table in the same transaction as
the record and drained by audit while the host runs; when 1000 events wait
undelivered the next write answers `503 audit_backlog` and changes nothing. See [audited writes](../../docs/STORE.md#audited-writes).

Back the database up while the server serves with
`urlcode-store backup --database <absolute store.sqlite> --destination <absolute new file>`:
an online copy through SQLite's backup API (Node 22.16 or newer) that refuses an
existing destination, is written `0600` and is checked as a store database of the
same schema version before it appears. To restore, stop the server and put the
copy in place. See [backups](../../docs/STORE.md#storage-and-concurrency-what-it-does-and-does-not-guarantee).

Another extension that requires the store reaches declared collections through
its typed export, `StoreExports` (`ctx.get('store')`): `create`, `get`, a
partial `update` (which clears a field given `null`, like `PATCH`) and a
paginated `list`, each scoped to the request principal exactly as the JSON API
is, a declared `transition`, and `transaction(work)`, which runs several of those
operations synchronously as one database transaction (trusted host code only,
never sandboxed). See [using a collection from another extension](../../docs/STORE.md#using-a-collection-from-another-extension).

## Transitions

A collection may declare named `transitions` (#835): `POST <mount>/<id>/<name>`
moves one record from the exact `from` values to the constant `set` values
(and the `stamp` values `actor` or `now`) in one transaction, honouring
`If-Match` and `Idempotency-Key`, or answers `409 transition_conflict` and
writes nothing. On an owned collection `by: others` lets any principal except
the owner run it, on a separate mount whose route policy decides who may; a
`transitionOnly` field can only change through a transition. A screen shows
such a field read-only and offers the transitions as buttons; `readers: true`
binds a screen to the readers mount, where the `by: others` transitions are
offered (see [transitions on a screen](../../docs/STORE.md#transitions-on-a-screen)).
Transitions are not an expression language: interval constraints and
multi-record transfers use a host transaction. See
[conditional transitions and result-aware retries](../../docs/STORE.md#conditional-transitions-and-result-aware-retries).
A list carries each listed record's `ETag` in `etags` and the transitions the
caller may run on it now in `may`, both keyed by id (one record's answer has
them as the `ETag` and `Allow-Transitions` headers), so a client sends
`If-Match` for the version it listed and offers only what the store would
accept. `may` reads only the caller's own membership, once per gate; see
[what the caller may run](../../docs/STORE.md#what-the-caller-may-run).

## Membership gates

Permissions are application data keyed by the principal id, not roles in auth
(#863). A collection declared `membership: true` with a `key` holds one record
per member, keyed by principal id. It has no mount and no HTTP API: the
operator maintains it with `urlcode-store members add|remove|list --database
<absolute store.sqlite> --project <absolute app> --collection <name>
[--principal <id>]` (or `addMember`, `removeMember` and `listMembers` from this
package), and trusted extension code through `StoreExports`. With
`audit: true` every added and removed member is recorded
(`store.membership.added`/`.removed`, subject `<collection>/<principal id>`)
in the same transaction as the change, and `urlcode-store reassign` moves a
principal's membership with its records. A transition
that names `members: <collection>` admits only members (`403
membership_required` before any record is read, the same for an existing and a
missing id). An owned collection's `readers: {mount, members}` lets members
list (with the declared filters and sort) and read every owner's records,
read-only, on a separate mount; `showOwner: true` adds each record's owner id
(`_owner`) to that mount's answers only. Membership is read inside each request's
transaction, so a change applies to the next request. See
[membership gates and cross-owner reads](../../docs/STORE.md#membership-gates-and-cross-owner-reads).

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
| `extensions.store.config.collections` | object | yes | maxProperties: 32; keys: "^[a-z][a-z0-9_-]{0,63}$" | Collections by name, each stored as rows of the site's store database (data/store.sqlite outside app/, chosen by the operator) and served as a bounded CRUD API at its mount. |
| `extensions.store.config.collections.*.mount` | string | no | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | URL path of the collection's JSON API; it needs a route `<mount>/*` with extension: store (GET, HEAD, POST, PUT, PATCH, DELETE). Required, except on a membership collection, which has none. |
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
| `extensions.store.config.collections.*.fields.*.transitionOnly` | boolean | no | — | true: only a declared transition (its set or stamp) changes the field. A create stores its default (or leaves it unset), PUT keeps its value, and a POST, PUT or PATCH body naming it answers 400. Not combinable with required, key or increments. A screen shows it read-only. |
| `extensions.store.config.collections.*.maxRecords` | integer | no | minimum: 1; maximum: 10000 | Records the collection may hold (default 1000); a create beyond it answers 409 collection_full. |
| `extensions.store.config.collections.*.maxRecordBytes` | integer | no | minimum: 256; maximum: 65536 | Largest serialized record in bytes (default 4096); larger answers 413. |
| `extensions.store.config.collections.*.pageSize` | integer | no | minimum: 1; maximum: 200 | Records per list page, and the cap on a list request's limit (default 50). |
| `extensions.store.config.collections.*.readOnly` | boolean | no | — | true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works. |
| `extensions.store.config.collections.*.key` | string | no | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string field (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner. |
| `extensions.store.config.collections.*.increments` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Numeric fields with a numeric default that POST `<mount>/<id>/increment/<field>` raises by exactly one in one database transaction, within the field's bounds. |
| `extensions.store.config.collections.*.idempotency` | object | no | unknown keys rejected | Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE, increment and transitions. A retry with a retained key and the same request (method, path, body) replays the first answer's status with the record as it is now; the same key on a different request answers 422 idempotency_key_reused. Without it the header answers 400 idempotency_not_enabled. A key is scoped to the request principal, or to the network client when there is none. |
| `extensions.store.config.collections.*.idempotency.maxKeys` | integer | yes | minimum: 1; maximum: 1000 | Newest distinct keys the collection retains, across all callers; an evicted key is no longer protected and a retry with it runs again. |
| `extensions.store.config.collections.*.sortable` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared fields a list request may sort by (sort=`<field>` or sort=`-<field>`). |
| `extensions.store.config.collections.*.filterable` | array | no | maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared fields a list request may filter by equality (`<field>`=`<value>`); limit, cursor and sort cannot be filterable. |
| `extensions.store.config.collections.*.ownership` | string | no | enum: ["shared","owner"] | shared (default): every caller who reaches the mount sees every record. owner: each record belongs to the principal that created it, and every read and write is scoped to it; the mount must carry a principal-providing policy such as auth: true. |
| `extensions.store.config.collections.*.maxRecordsPerOwner` | integer | no | minimum: 1; maximum: 10000 | With ownership: owner only: records one principal may hold, at most maxRecords; beyond it a create answers 409 owner_quota_exceeded. |
| `extensions.store.config.collections.*.audit` | boolean | no | — | true: every write is recorded in the audit log (field names and the principal, never values), in the same transaction as the write. On a membership collection, adding or removing a member (from any path, the operator CLI included) records store.membership.added or store.membership.removed with the member's principal id in the subject. Needs the audit extension; writes answer 503 audit_backlog while 1000 events wait to drain. |
| `extensions.store.config.collections.*.transitions` | object | no | maxProperties: 16; keys: "^[a-z][a-z0-9_-]{0,63}$" | Declared conditional state changes by name: POST `<mount>/<id>/<name>` moves one record from the from values to the set (and stamp) values in one transaction, honouring If-Match and Idempotency-Key; a record not in the from state answers 409 transition_conflict and nothing is written. Not an expression language. |
| `extensions.store.config.collections.*.transitions.*.from` | object | yes | minProperties: 1; maxProperties: 8; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string / number / boolean (one of: string (maxLength: 256); number; boolean) | Declared fields and the exact value each must currently hold; each value must be valid for its field. |
| `extensions.store.config.collections.*.transitions.*.set` | object | yes | minProperties: 1; maxProperties: 8; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string / number / boolean (one of: string (maxLength: 256); number; boolean) | Declared fields and the constant value the transition writes; not the collection key. |
| `extensions.store.config.collections.*.transitions.*.stamp` | object | no | maxProperties: 4; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string (enum: ["actor","now"]) | String fields the store fills: actor (the principal id, needs maxLength of at least 128) or now (the commit time in ISO 8601, needs maxLength of at least 24). No enum or format. |
| `extensions.store.config.collections.*.transitions.*.by` | string | no | enum: ["owner","others"] | With ownership: owner only. owner (default): only the record's owner, on the collection mount. others: any principal except the record's owner (the owner gets 403 own_record_refused), served on its own mount. |
| `extensions.store.config.collections.*.transitions.*.mount` | string | no | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | Required with by: others, refused otherwise: the transition is served as POST `<mount>/<id>` on a route `<mount>/*` with extension: store (POST) and a principal-providing policy. |
| `extensions.store.config.collections.*.transitions.*.members` | string | no | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A membership collection (membership: true): only principals it lists may run the transition; anyone else gets 403 membership_required before any record is read. Checked inside the write transaction, so a membership change applies to the next request. |
| `extensions.store.config.collections.*.membership` | boolean | no | — | true: a membership list. Its key field holds principal ids (one record per member); transitions and readers name it in members. It has no mount and no HTTP API: the operator maintains it with urlcode-store members or trusted extension code (StoreExports); a member's key cannot be changed, only removed and added. Needs key; takes no mount, ownership, transitions, readers, increments, idempotency, sortable, filterable or readOnly. With audit: true every added and removed member is recorded. |
| `extensions.store.config.collections.*.readers` | object | no | unknown keys rejected | With ownership: owner only: members of a membership collection list and read every owner's records, read-only, as GET `<mount>` (with the collection's limit, cursor, sort and filters) and GET `<mount>/<id>`. Owners keep their own view on the collection mount. The stored owner is shown only with showOwner. |
| `extensions.store.config.collections.*.readers.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | A separate mount: a route `<mount>/*` with extension: store (GET, HEAD) and a principal-providing policy. |
| `extensions.store.config.collections.*.readers.members` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A membership collection: anyone it does not list gets 403 membership_required before any record is read. |
| `extensions.store.config.collections.*.readers.showOwner` | boolean | no | — | true: every record this mount answers carries _owner, the opaque principal id of the owner (for auth, the user id; never an email or name), so a member can tell requesters apart. Only this mount shows it: the owner's mount, transitions and StoreExports never do. |
| `extensions.store.config.shortLinks` | object | no | maxProperties: 32; keys: "^[a-z][a-z0-9_-]{0,63}$" | Public redirect mounts by name: GET `<mount>/<key>` atomically increments a counter and answers 302 to the record's stored destination; HEAD answers the same 302 without counting; an unknown key is 404. Each needs a route `<mount>/*` with extension: store (GET, HEAD). |
| `extensions.store.config.shortLinks.*.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$" | URL path of the redirect mount, separate from the collection's CRUD mount. |
| `extensions.store.config.shortLinks.*.collection` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A declared shared collection with a key; the key value is the path segment after the mount. |
| `extensions.store.config.shortLinks.*.destination` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A required string field with format: http-url holding the redirect target; activation refuses it otherwise. |
| `extensions.store.config.shortLinks.*.clicks` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A field listed in the collection's increments, raised by one on each GET (even when the collection is readOnly). |
| `extensions.store.config.screens` | object | no | maxProperties: 16; keys: "^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$" | List-and-form screens by exact page path, each for one declared collection. The store hands them to ui through contributes.ui; each needs a route `<path>/*` with extension: ui (GET, HEAD). Ignored when ui is not installed. |
| `extensions.store.config.screens.*.collection` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A collection declared under collections; activation fails otherwise. |
| `extensions.store.config.screens.*.title` | string | no | minLength: 1; maxLength: 80 | Page title. Default: the collection name in sentence case. |
| `extensions.store.config.screens.*.readers` | boolean | no | — | true: the screen lists the collection's readers mount (every owner's records, read-only) and offers its by: others transitions; the collection must declare readers. Default false: the collection mount, with create, edit, delete and the transitions its owner runs. |
| `extensions.store.config.screens.*.columns` | array | no | minItems: 1; maxItems: 64 | Fields shown in the list, in order: a field name, or {field, label} to set the heading. Default: every declared field. Unless the collection is readOnly, every required field without a default must be listed, or ui refuses the screen. |
| `extensions.store.config.screens.*.columns[].field` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | A declared field of the collection. |
| `extensions.store.config.screens.*.columns[].label` | string | no | minLength: 1; maxLength: 80 | Column heading. Default: the field name. |

### Authoring surfaces and limits

Declare collections under extensions.store.config.collections and mount each on a route with `extension: store`. Bounded unique keys, numeric increments, idempotency retention and short-link redirects remain store-owned; no handler code is needed.

- **collections** (configuration, `urlcode.yaml`): Per-collection mount, typed fields (including `format: http-url`), bounded unique `key`, numeric `increments`, durable bounded `idempotency`, maxRecords, maxRecordBytes, pageSize, readOnly, `sortable` / `filterable` field lists, and `ownership: owner` (per-record ownership: each signed-in principal sees and changes only its own records; the mount must be guarded by a principal-providing policy such as `auth: true`) with an optional `maxRecordsPerOwner` (at most maxRecords; a principal at it gets `409 owner_quota_exceeded`), `audit: true` (every write recorded in the audit log with field names and the principal, never values; needs the audit extension, and writes answer `503 audit_backlog` while 1000 events wait to drain), and declared `transitions`.
- **membership** (configuration, `urlcode.yaml`): Permissions as data keyed by the principal id, never roles in auth: a `membership: true` collection with a `key` lists principal ids and has no mount (the operator maintains it with `addMember`/`removeMember`); a transition's `members: <collection>` admits only its members, and an owned collection's `readers: {mount, members}` lets members list and read every owner's records read-only on a separate mount.
- **shortLinks** (configuration, `urlcode.yaml`): Optional public GET redirect mounts that look up a collection key, use a declared HTTP(S) destination field, and atomically increment a declared counter.
- **mount** (extension, `urlcode.yaml`): Collection routes `/api/<name>/*` use GET, HEAD, POST, PUT, PATCH, DELETE; short-link routes use GET, HEAD. Readers routes use GET, HEAD and a `by: others` transition route uses POST. Add `auth: true` to any private mount; an `ownership: owner` collection requires it (or another principal-providing policy).
- **screens** (configuration, `urlcode.yaml`): Optional list-and-form screens (`/todos: {collection: todos, title?, columns?, readers?}`) for declared collections, with transitionOnly fields read-only and declared transitions as buttons. The store hands them to the ui extension through contributes.ui; each needs a route `<path>/*` with `extension: ui`, methods GET and HEAD. Ignored when ui is not installed.

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
