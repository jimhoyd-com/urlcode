# @jimhoyd/urlcode-store

## Unreleased

Audited writes. A collection may declare `audit: true`: every create, replace, update, delete and increment is recorded as `store.record.created|replaced|updated|deleted|incremented` (subject `<collection>/<id>`, actor the request principal or `anonymous`, metadata `{collection, fields}` with field names only, `truncated: true` when cut). The event is written into the collection's data file, in a new `audit` array, in the same atomic write as the record, and the audit extension drains it while the host runs; at 1000 undelivered events a write answers `503 audit_backlog` and changes nothing. The store `uses` audit: a collection with `audit: true` refuses activation when audit is not installed or when no principal-providing policy guards its mount, a short-link click is never audited, and turning `audit` off keeps undelivered events in the file. The `urlcode-store` ownership commands keep the outbox and add no event. `createStore` returns `{registration, exports, close}`; `AUDIT_BACKLOG` and the `CollectionAuditor` type are exported, and collection write methods take a trailing `actor`.

The `--example` API mount uses `auth: {csrf: origin}` when auth is installed, so the CRUD screen's JSON writes pass auth without its token header, and the `todos` collection declares `audit: true` when audit is installed.

Requests use core's helpers: the body is read before the media type is checked (413 before 415), `Sec-Fetch-Site: cross-site` and duplicated provenance headers are refused, a request with no `Origin` whose `Referer` names a foreign origin is refused, invalid UTF-8 is `invalid_encoding`, and JSON answers carry core's deny-all CSP and referrer policy.

Clearing a field (#738). A `PATCH` body, and the records export's partial `update`, may set an optional field to `null` to remove it from the record; a body of only such clears is a valid change. `null` for a required field is refused with `400 invalid_record` and the field error `is required and cannot be cleared` (and for an increment field, `is an increment field and cannot be cleared`); ownership scoping, `If-Match`/`412` and validation of the other fields apply as before, and a refused patch changes nothing. `PUT` is unchanged: `null` is not a value there. Before this, `null` was refused as the field's wrong type, so no previously accepted request changes meaning. The records export also gains `list(principal, {limit, cursor})`: one page of the principal's scope in creation order, with `total`, `next` and `previous` cursors, `limit` capped at the collection's `pageSize`, the same scoping and `400 invalid_query` as the JSON list.

`urlcode-store reassign --directory <dir> --project <app> --from <principal id> --to <principal id> [--collection <name>] [--dry-run]` moves every record one principal owns to another, for example a rotated API key's `apikey:<id>` records to its replacement (#732). It reads the project to find the `ownership: owner` collections and their `maxRecordsPerOwner`, takes the directory lock like the `ownerless` commands (so it refuses while the server runs), validates both ids with core's principal pattern, and prints per-collection counts; `--dry-run` writes nothing. When the move would put `--to` over a collection's `maxRecordsPerOwner` the whole operation is refused, naming the collection, and nothing is written. Exported as `reassignOwner`.

Per-owner record limit (#731). An owned collection may declare `maxRecordsPerOwner: N` (at most its `maxRecords`, default 1,000; activation refuses it on a shared collection or above `maxRecords`). A create by a principal that already holds N records answers `409 owner_quota_exceeded`, whose message states no count, limit or collection total; `maxRecords` stays the collection-wide ceiling (`409 collection_full`). Counts are derived from the loaded records, so they are correct after a restart and after `ownerless-assign`/`ownerless-delete`; records with no owner count toward no principal, and a replayed `Idempotency-Key` is refused before anything is counted.

A records export for other extensions (#529): `host()` now returns `StoreExports` (contract version 1), read with `ctx.get('store')` by an extension that requires the store. `records(name)` gives a declared collection's `ownership`, `readOnly` and frozen `fields`, and `create`, `get` and a partial `update` (with optional `ifMatch`) that take the request principal and apply the same ownership scoping, validation, limits and ETags as the JSON API, failing with the same `StoreError` statuses and codes. `createStore` returns the registration and the exports; `storeExtension` is unchanged.

Per-record ownership (#331). A collection may declare `ownership: owner` (default `shared`, unchanged). It is scoped to core's opaque request principal, set by a principal-providing policy on the mount's route (auth's `auth: true`): create stamps the principal as the record's owner, stored as `_owner` in the data file and never returned; list, read, `PUT`, `PATCH`, `DELETE` and increment see only the caller's records, and another principal's record answers the same `404` as a missing id, before `If-Match` or body checks; a request without a principal is `401 principal_required`; a body naming `_owner` is `400`; `Idempotency-Key` retention is also scoped by principal. Activation refuses an owned collection whose mount has no principal-providing policy, an owned collection with a `key` (and so short links), and a shared collection whose file holds owned records. Records written before a collection became owned are served to nobody; the new `urlcode-store ownerless | ownerless-assign --owner <id> | ownerless-delete` commands (and `reportOwnerless`, `assignOwnerless`, `deleteOwnerless`) report them and assign or delete them with the server stopped. The CRUD screen is multi-user-safe only on an owned collection. The `--example` `todos` collection is owned (`ownership: owner`) when auth is installed, in the same command or already; without auth it stays shared and still needs `--ack store:public-write`.

Writes whose `Origin` is one of the operator's site-wide alias origins (`--alias-origin`, `aliasOrigins`) are admitted like the canonical origin, using core's `isSiteOrigin`; an unlisted origin is still refused with `403 forbidden_origin` (#717).

**Default behavior change:** `urlcode extensions add` (and `init --with`) now installs only the capability; the new `--example` flag, the same for every extension, writes the sample behavior it used to write by default (#711). A blank `extensions add store` writes an empty `collections` block, no mount and needs no acknowledgement (`collections` may now be empty); `--example` writes the `todos` collection on `/api/todos` and, with ui, its `/todos` screen, and still requires `--ack store:public-write` without auth. To reproduce the old result, add `--example`.

The store owns its CRUD screen (#709). Screens are declared under `extensions.store.config.screens` (`/todos: {collection: todos, title?, columns?}`, the shape that used to live under `extensions.ui.config.screens`), activation refuses a screen naming an undeclared collection, and the definition's optional `contributes.ui.screens` hands ui a generic description of each, so ui no longer reads `extensions.store`. The scaffold adds the `/todos` screen and its `extension: ui` route when ui is installed. `@jimhoyd/urlcode-ui` is declared an optional peer, and `urlcode.json` records the optional edge as `contributes: ["ui"]`.

## 0.5.0

Align the coordinated stable release at `0.5.0` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.9

Align the coordinated stable release at `0.4.9` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.6

Align the coordinated stable release at `0.4.6` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3, 0.4.4 and 0.4.5 were prepared but never published, so npm went from 0.4.2 straight to this release. 0.4.3's candidate failed in the release container (two checks called `git ls-files` on a checkout owned by another user); 0.4.4's publisher stopped at its preflight (the peer-floor guard held core itself to a floor it cannot have); 0.4.5 stopped at the CI gate, where the slowest runner (Windows, Node 22) took over 500 ms for a pattern the guard accepts. The `v0.4.4` tag stays where it is. This release fixes all three, and lowers the input bound for schema `pattern` from 256 to 128 characters (a schema that sets `pattern` now needs `maxLength` of at most 128), which makes the worst accepted pattern about eight times cheaper. It carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.5

Align the coordinated stable release at `0.4.5` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3 and 0.4.4 were prepared but never published. The 0.4.3 candidate failed in the release container because two checks called `git ls-files` on a checkout owned by another user. The 0.4.4 publisher then stopped at its preflight, which held core itself to a peer floor it cannot have. Nothing was published for either version (npm went from 0.4.2 straight to this release), and the `v0.4.4` tag stays where it is. This release fixes both and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.4

Align the coordinated stable release at `0.4.4` on npm’s `latest` channel. Internal peer minimums advance to this release.

Version 0.4.3 was prepared but never published: its candidate build failed in the release container because two checks called `git ls-files` on a checkout owned by another user, which git refuses as dubious ownership. Nothing was tagged or published for 0.4.3. This release fixes those checks and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`, on top of 0.4.2. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, the store collection sorting and filtering, the data-bound CRUD screen, and the first store extension release line.

## 0.4.3

Align the coordinated stable release at `0.4.3` on npm’s `latest` channel. Internal peer minimums advance to this release.

Collections declare `sortable` and `filterable` fields; list requests take one `sort=<field>` or `sort=-<field>` and up to three equality filters with a stable id tie-break, sorted pages use an opaque cursor that cannot repeat or skip records, and undeclared or malformed names return 400 naming only the key. Unknown query parameters on a list request now return 400 instead of being ignored. The scaffold refuses a writable mount that no access-control extension protects unless `--ack store:public-write` is passed, and writes the access model into the generated README and routes. The unordered `--with` contract is supported.

The store needs a core release that has `--ack`, the unordered `--with` contract and the extension authoring contract, and its first publication peered on a core that lacks all three. This release's core peer floor is raised to the core release that has them, and release preparation and the publish preflight now refuse a floor below the core API the package uses. The README explains the unknown-option failure an older core produces.

## 0.4.2

First publication, made by hand from the source at commit `7972185` because the release scripts assume a package already exists on npm. It was not built or verified by the release pipeline, so it has no signed `train.json` and no version tag.

It assumes core changes (`--ack`, an unordered `--with`, an extension `authoring` contract) that the published core `0.4.2` does not contain, although its peer range allows that core. Use the next release of both packages; see the version alignment page.
