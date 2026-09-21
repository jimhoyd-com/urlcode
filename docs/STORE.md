# Data store extension and CRUD recipe

`@jimhoyd/urlcode-store` is an operator-installed extension (see
[extensions](EXTENSIONS.md)) that serves declared collections as a bounded JSON
CRUD API. It is not core: the project declares collections and mounts, the
operator installs the package and chooses where the data lives, and application
data stays in the operator's systems. A Todo app needs no handler code.

Why it is an extension: core has no persistence handler, and the earlier stored
short-link extension was retired because that product did not belong, not
because operator-installed data extensions fail. The project first ran locked
down in a sandbox and later moved to trust by default
([direction](PROJECT-DIRECTION.md)); that change lets core stay small while
data-owning features ship as extensions the operator reviews and pins.

## Recipe: a Todo API in three steps

```sh
npm install @jimhoyd/urlcode @jimhoyd/urlcode-store   # in a scratch directory
npx urlcode init todo-site --with store --ack store:public-write   # or --with ui,auth,store: see below
cd todo-site && npm install
```

`init --with store` writes the starter under `app/`, one `host.mjs`, a README
and a `package.json` pinning the versions it resolved. `app/urlcode.yaml`
declares the collection and its mount:

```yaml
version: "1"
extensions:
  store:
    version: "1"
    config:
      collections:
        todos:
          mount: /api/todos
          fields:
            title: {type: string, required: true, minLength: 1, maxLength: 200}
            done: {type: boolean, default: false}
          maxRecords: 1000
          maxRecordBytes: 4096
routes:
  /api/todos/*:
    extension: store
    methods: [GET, HEAD, POST, PUT, PATCH, DELETE]
```

Review the project, pin its revision, and serve:

```sh
npx urlcode extensions --project app --host-file "$PWD/host.mjs"    # inspect schemas
PROJECT_SHA256=$(node -e "import('@jimhoyd/urlcode/extensions').then(async m=>console.log(await m.inspectExtensionRevision('app')))") \
  npx urlcode serve --project app --host-file "$PWD/host.mjs" --origin https://todo.example.com
curl -X POST -H 'Content-Type: application/json' -d '{"title":"first"}' https://todo.example.com/api/todos
```

With `--with ui,auth,store` (in any order) the scaffold adds `auth: true`
to the mount and reads the same `PROJECT_SHA256` revision, so only signed-in callers reach
the API and the screen; no acknowledgement is needed.

Without `auth` the mount would be a public writable endpoint, so
`init --with store` (with or without `ui`) refuses before writing anything and
names the two ways forward: add `auth` to `--with`, or re-run the exact command
it prints, which ends in `--ack store:public-write`, when public writes are
really intended. Core's generic `--ack <extension>:<id>` flag (see
[extensions](EXTENSIONS.md)) is visible in command history and rejected when no
scaffold consumes it; the generated README and `routes/extensions.yaml`
then state the access model as public write. That is an acknowledgement, not a
control: it is not rate limiting, abuse protection or multi-tenant isolation
(the store keeps only its record and size bounds and the origin and CSRF checks).
The flag is rejected when it would have no effect (auth composed, or no `store`).
A hand-authored public mount, as in the YAML above, stays supported.

## HTTP contract

| Request | Answer |
|---|---|
| `GET /api/todos?limit=&cursor=` | `200 {items, total, next?}` in creation order; `limit` is capped at the collection `pageSize`, `cursor` is the offset from `next` |
| `GET /api/todos?sort=-priority&kind=a&cursor=` | the same shape, sorted and filtered as [declared](#sorting-and-filtering); `total` counts the matches and `cursor` is the opaque `next` of a sorted page |
| `POST /api/todos` | `201` and the record, `Location: /api/todos/<id>` |
| `GET /api/todos/<id>` | `200` record, or `404` |
| `PUT /api/todos/<id>` | replaces every declared field (omitted fields take their default), `200` |
| `PATCH /api/todos/<id>` | updates the supplied fields, `200` |
| `DELETE /api/todos/<id>` | `204` |

Every record carries a server-assigned UUID `id`, `createdAt` and `updatedAt`
(ISO 8601). Clients cannot set them. Writes need `Content-Type:
application/json` (`415` otherwise); a cross-origin `Origin` header on a write
is refused (`403`). Errors are `{error: {code, message, fields?}}` where
`fields` maps field names to fixed messages; submitted values are never echoed.
Status codes: `400` invalid record or JSON, `404`, `405` with `Allow`, `409`
`collection_full`, `413` body or record too large, `415`, `503` when the disk
write failed, `500` for anything unexpected (no cause in the body).

## Field schema

Fields are typed `string`, `integer`, `number` or `boolean`, each optionally
`required`, with a `default` (not both), and per type: `minLength`/`maxLength`
(strings, hard cap 65,536), `minimum`/`maximum` (numbers), `enum`. The store owns
this schema and does not depend on request-body validation in core ([#254]).
Unknown fields are rejected. `id`, `createdAt` and `updatedAt` are reserved.

Limits per collection: up to 64 fields, `maxRecords` up to 10,000 (default
1,000), `maxRecordBytes` up to 65,536 (default 4,096), `pageSize` up to 200
(default 50), at most 32 collections per project, `readOnly: true` to refuse
writes. The request body is refused above `maxRecordBytes` plus 4 KiB.

## Sorting and filtering

A collection opts in per field with two lists in its declaration:

```yaml
sortable: [title, priority]      # sort=<field> or sort=-<field> (descending)
filterable: [kind, done]         # <field>=<value>, equality only
```

- Every name must be a declared field (not `id`, `createdAt` or `updatedAt`),
  at most 8 per list, no repeats. A `string` field must have `maxLength` of at
  most 256 or an `enum`, so a value stays small enough to compare and to carry
  in a cursor. A field named `limit`, `cursor` or `sort` cannot be filterable.
  A bad declaration refuses activation.
- One sort field per request. Records order by that field, then by `id`, so the
  order is total and stable. `-` reverses the whole order, ties included.
  Numbers compare numerically, booleans `false` before `true`, strings by UTF-16
  code unit (not by locale). A record with no value for the field (an optional
  field never set) comes after every record that has one when ascending, and
  first when descending.
- Filters are exact equality on the declared type: `done=true`, `priority=3`
  (integers and numbers are parsed strictly, so `3.0` matches 3 and `0x10`
  does not parse), `kind=a`. At most 3 filters per request, each given once;
  a record without a value never matches. Filters combine with AND and with
  `sort`; `total` is the number of matches.
- Anything else is `400 invalid_query` with `fields` naming the key: an
  undeclared sort or filter name, a repeated key, a value that does not parse,
  an unrelated parameter such as `q`, more than 16 parameters. Names that are
  not plain identifiers are reported as `(unsupported name)`, and values are
  never echoed. Unknown query parameters are therefore refused rather than
  ignored on every collection, declared or not. There are no ranges,
  operators, text search, OR, nested paths or arbitrary expressions.
- A sorted page returns an opaque `next` cursor holding the sort field and
  direction and the position (value and `id`) of the page's last record. The
  next page is "the records after that position", so records inserted, deleted
  or edited between requests never make a page repeat a record or skip one that
  stayed put. A cursor works only with the sort that issued it (`400`
  otherwise). Without `sort`, `cursor` stays the numeric offset in creation
  order, filtered or not; there a delete between pages can shift later records
  up by one.
- The whole collection is sorted and filtered in memory per request, bounded by
  `maxRecords` (at most 10,000). Sorting and filtering apply to the whole
  collection: the store has no per-record ownership ([#331](https://github.com/jimhoyd-com/urlcode/issues/331)), and nothing here
  assumes it.

## Storage and concurrency: what it does and does not guarantee

- One JSON file per collection in the operator directory (default `data/store`
  beside `host.mjs`, or `STORE_DIRECTORY`). The directory must be outside the
  project (checked after symlink resolution) and is created `0700`, files `0600`.
- Each write goes to a temporary file, is fsynced, then renamed over the
  collection file, and the directory is fsynced (best effort). A crash leaves
  either the old or the new file, never a torn one; a failed write changes
  nothing in memory or on disk.
- Writes within one process are applied strictly one at a time per collection,
  so concurrent requests cannot interleave or lose each other's updates in that
  process.
- The directory is single-writer. Activation takes an exclusive lock file
  (`.store.lock`, holding the pid) and refuses a second server over the same
  directory; a lock left by a dead process is reclaimed. This is a guard against
  mistakes, not a distributed lock: it does not work across machines or on
  network filesystems, and the same host needs one process (no `workers`
  multi-process clustering over the same directory).
- Every write rewrites the whole collection file, so cost grows with the
  collection size; the record and byte caps bound it. There is no transaction
  across records or collections, no index and no query language beyond
  paginated listing with declared sorting and equality filtering, no optimistic concurrency (`PUT`/`PATCH` are last write
  wins), and no history. Startup loads and revalidates every record; a file that
  no longer matches the declared fields refuses activation rather than serving
  bad data.
- Backups are the operator's: copy the directory while the server is stopped, or
  accept that a copy taken mid-write is the last complete file.

Errors never contain record values, file contents or filesystem paths.

## Trust and operation

The store is trusted operator code. It is not sandboxed and is not a
multi-tenant boundary: every caller who can reach a mount sees the whole
collection, so restrict the mount with `auth` (or another policy) and keep
per-user data out of a shared collection. There is no per-user ownership model
yet. Changing collections or mounts changes the project revision and needs a new
operator pin. The mount responses are `no-store`.

## Catalog recipe

`urlcode recipes search "crud store persist"` finds `store-crud`
([recipes](RECIPES.md)), the same collection as above with ordered fixtures for
the whole create, read, update, delete lifecycle. It does not install anything:
the operator must install `@jimhoyd/urlcode-store` (on npm) and write
a host file. `init --with ui,auth,store` scaffolds one from the published
packages. A no-auth `init --with store` needs `--ack store:public-write`, which the
core published at the store's first release does not have; see [the first-publish runbook](FIRST-NPM-PUBLISH.md).

## A screen for the collection

`npx urlcode init todo-site --with ui,auth,store` (or `--with ui,store --ack store:public-write`) also serves `/todos`, a
list with a create form, inline edit and delete. The `ui` extension reads the
collection's fields from `extensions.store` in `app/urlcode.yaml` when it starts,
so a Todo app declares its fields once and gets both the API and the screen; add
a field there, re-review and re-pin, and it appears on both. `extensions.ui`
gets one entry, and the screen a route:

```yaml
extensions:
  ui:
    version: "1"
    config:
      screens:
        /todos: {collection: todos, title: Todos}
routes:
  /todos/*: {extension: ui, methods: [GET, HEAD]}
```

The page is server-rendered escaped shell only; the browser loads the records
from the store's own `/api/todos` with the kit's `crud` script, served
content-hashed and loaded with the page nonce, under a strict CSP (`connect-src
'self'`, no inline script). Record values are only ever written as text. An
edit in progress survives a reload of the list, and a checkbox toggle that the
server refuses is rolled back. With `auth` composed, the screen route carries
`auth: true` like the API mount, which gates who can *reach* it — not who owns
which record. The store has no per-record ownership ([#331], decided: not
built), so every signed-in caller sees and edits the whole collection through
this screen. It is a single-user or trusted-group surface, not a multi-user
one; do not read `auth` on the route as record-level access control. Text
fields become inputs (a textarea above 200
characters), enums selects, numbers number inputs and booleans checkboxes;
labels come from the field names unless the screen sets `columns`
(`columns: [title, {field: done, label: Finished}]`) to choose, order and
relabel the fields shown. Details and limits are in the
[ui package README](../packages/ui/README.md#data-bound-screens).

## Not built yet

Recorded in [open decisions](OPEN-DECISIONS.md): publishing the package to npm
([#323]; the release wiring is merged, the first release needs maintainer
approval), per-record ownership, a SQLite backend, ranges and text search, and
richer screens beyond the first slice ([#262]): labels, columns, sort and
filter controls have all shipped ([#330](https://github.com/jimhoyd-com/urlcode/issues/330)).
