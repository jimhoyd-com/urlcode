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
Short version: one server process per directory (enforced by a lock file),
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

The `store-schema` artifact (`urlcode artifacts add store-schema`) carries this
extension's configuration schema and an example configuration as inert JSON
for authoring tools; it does not register `store` or grant access to a data
directory. See [artifacts](../../docs/EXTENSIONS.md#artifacts).

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
