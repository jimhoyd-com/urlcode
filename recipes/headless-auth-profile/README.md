# Headless auth and profile

A JSON API for registration, sign-in, a signed-in user's profile and sign-out,
with no handler code. Two operator-installed extensions do the work:

- `auth` serves `/account/*`: accounts, sessions, CSRF tokens and the
  auth-owned profile, answering JSON to a client that sends
  `Accept: application/json` ([auth JSON contract](../../packages/auth/docs/JSON-API.md)).
- `store` serves `/api/profile/*`: the application's own profile data, one
  record per user, in a collection declared `ownership: owner`. `auth: true`
  on the mount makes auth check the session and hand the store the user's id as
  the request principal; the store scopes every request to it
  ([per-record ownership](../../docs/STORE.md#per-record-ownership)).

Nothing here is a second authentication implementation: no function reads a
cookie, checks a password or compares user ids. If a requirement seems to need
one, it is a gap to report, not code to add.

## Who owns what

| Concern | Owner | Where it lives |
|---|---|---|
| Email, password, sessions, roles, CSRF tokens, sign-out | auth | the operator's auth database |
| `displayName`, `locale` and operator-declared registration metadata | auth (the auth-owned profile) | the same database; `POST /account/profile` |
| `bio`, `website` and any other field the application declares | the application | the `profiles` store collection in `urlcode.yaml` |
| Which user owns a profile record | store, from auth's principal | the record's hidden `_owner`, never in a response |
| Keys, database paths, registration mode, roles, data directory | the operator | `operator-service.mjs`, `host.mjs` and `data/`, outside the project |

The project declares the extensions, the mounts and the collection. It never
chooses or loads a package, and holds no secret: there is no `AUTH_SECRET` in
the project, in route YAML or in a route's environment. Auth's key material
(`data/encryption.key`, `data/csrf.key`) belongs to the operator, and routes
reach the shared auth service only through the extension the host composes.

## Why a JSON-only site mounts `ui`

The project declares `/assets/ui/*: {extension: ui}` although this API serves
no page of its own. That is intended ([#812](https://github.com/jimhoyd-com/urlcode/issues/812)):

- auth requires the `ui` extension. `ui` is auth's only render path: the same
  `/account/*` mount that answers JSON to `Accept: application/json` answers
  its account pages to any other client, such as a browser that follows a link
  to `/account/login`. Auth refuses to activate without an active `ui`.
- `ui` activates only with exactly one asset mount, because the pages it renders
  link their stylesheet and scripts under it. Without one, activation stops with
  `ui extension needs exactly one route mount`.

The mount is harmless. It answers `GET` and `HEAD` only, serves nothing but the
kit's content-hashed stylesheet and scripts under `/assets/ui/static/` (`404`
for any other path), sets no cookie, reads no request data and holds no state.

## Operator setup

In a new site ([site layout](../../docs/EXTENSIONS.md#the-site-layout)):

```sh
npx urlcode init profile-api --with ui,auth,store
cd profile-api
rm -r app && npx urlcode recipes add headless-auth-profile --out app
```

`init` writes `host.mjs`, `operator-service.mjs` and fresh keys in `data/`.
The host lists every extension the project declares; the site's host already
reads like this:

```js
// host.mjs -- trusted operator code, outside app/
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [audit(), mail(), ui(), auth(), store()]);
```

Open registration in `operator-service.mjs` (`registrationMode: 'open'`) before
the first start. The project's `registration: open` must match it, or auth
refuses to activate. Changing the mode of a database that already exists is a
reviewed configuration migration (see the
[auth README](../../packages/auth/README.md)).

An operator who keeps key material in the environment rather than in `data/`
reads it in operator code, never in the project: `encryptionKey:
Buffer.from(process.env.AUTH_ENCRYPTION_KEY, 'base64')` in
`operator-service.mjs`, and `auth({csrfKey: Buffer.from(process.env.AUTH_CSRF_KEY,
'base64')})` in `host.mjs`, each exactly 32 bytes.

Review the project, print its revision once and pin it, then run from the site:

```sh
npx urlcode extensions --project app          # prints "Project revision: <sha256>"
export PROJECT_SHA256=<the reviewed revision>
npx urlcode validate --local --host-file host.mjs --origin https://api.example.com
npx urlcode test --host-file host.mjs --origin https://api.example.com
npx urlcode audit --expect-routes 3 --host-file host.mjs --origin https://api.example.com
npx urlcode serve --host-file host.mjs --origin https://api.example.com
```

Editing `urlcode.yaml`, including a new profile field, changes the revision and
needs a new review and pin.

## The client protocol

Every request sends `Accept: application/json` and keeps the cookies auth sets
(the session cookie is `__Host-urlcode-session`: HTTPS, `HttpOnly`,
`SameSite=Strict`). Every write also sends:

- `Content-Type: application/json`;
- `Origin: <the site origin>`; a missing or foreign origin is `403`;
- `X-CSRF-Token: <csrf>`, the latest `csrf` value auth returned. Before a
  session exists it comes from `GET /account/csrf`, bound to the flow cookie
  that response sets; `register` and `login` return one bound to the new
  session. A store body cannot carry `csrf` (undeclared fields are `400`), so
  send the header.

Every JSON response carries `Cache-Control: no-store`.

### Auth-owned endpoints (`/account/*`)

| Request | Success | Other statuses |
|---|---|---|
| `GET /account/csrf` | `200 {csrf}`, sets the flow cookie | |
| `POST /account/register` `{email, password, displayName?, locale?}` | `201 {user, csrf}`, sets the session cookie | `400` invalid email or a password under 15 characters, `403` missing token or origin; an address that already has an account gets the same `201` shape with no session and the owner is notified |
| `POST /account/login` `{email, password}` | `200 {user, csrf}`, sets a new session cookie | `401` wrong credentials, `403` missing token or origin |
| `GET /account/account` | `200 {user, csrf}` | `401` signed out or revoked |
| `POST /account/profile` `{displayName?, locale?}` | `200 {profile}` | `401`, `403` |
| `POST /account/logout` `{}` | `200 {signedOut: true}`, revokes this session and clears its cookie | `401` with a revoked session, `403` missing token or origin |

`user` is `{id, email, emailVerified, status, roles, created, totpEnabled,
profile}`; `profile` is `{displayName?, locale?, metadata}`. The complete list,
including sessions, password change and account export, is the
[auth JSON contract](../../packages/auth/docs/JSON-API.md). Auth errors are
`{error: <message>}`.

### Application profile (`/api/profile/*`)

| Request | Success | Other statuses |
|---|---|---|
| `GET /api/profile` | `200 {items, total}`: the caller's own record or none | `401` |
| `POST /api/profile` `{bio?, website?}` | `201` the record `{id, createdAt, updatedAt, bio?, website?}`, `Location: /api/profile/<id>` | `400` invalid or undeclared field, `401`, `403`, `409 owner_quota_exceeded` when the caller already has a profile, `415` not JSON |
| `GET /api/profile/<id>` | `200` the record | `401`, `404` missing or another user's |
| `PATCH /api/profile/<id>` | `200` the record with the supplied fields changed (`null` removes one) | `400`, `401`, `403`, `404` |
| `PUT /api/profile/<id>` | `200` the record with every field replaced | `400`, `401`, `403`, `404` |
| `DELETE /api/profile/<id>` | `204` | `401`, `403`, `404` |

Store errors are `{error: {code, message, fields?}}`. Another user's record
answers exactly the `404 not_found` a missing id does, for every method, so a
caller learns nothing about records it does not own. A signed-out or revoked
session is `401` before the store reads anything.

## What the tests cover

`tests/requests.json` holds the signed-out cases (the CSRF endpoint, and `401`
or `403` on every protected route and method) and one `steps` fixture for the
whole signed-in lifecycle. The fixture is one client with its own
[cookie jar](../../docs/READINESS.md#cookies), so the session cookie auth sets
on sign-in is sent on every later step:

1. `GET /account/csrf`, then `POST /account/register` and `POST /account/login`
   as Ada, each write carrying the latest `csrf` the fixture captured;
2. the auth-owned profile read and updated, and the application profile created,
   read, patched and replaced, with `HEAD`, the second-record `409` and a stale
   token or foreign `Origin` refused with `403`;
3. `POST /account/logout`, then Ada's old session cookie (captured with
   `{"cookie": "__Host-urlcode-session"}`) replayed through an explicit
   `cookie` header and refused with `401` on every endpoint;
4. Bob signs up and in, sees his own empty profile, and gets `404` for every
   method on Ada's record;
5. Ada signs in again, sees her record unchanged, and deletes it.

Registration is followed by sign-in because an address that already has an
account answers `201` with no session, and the fixture deletes the record it
created: it runs again against the same operator database. No cookie value is
printed in a failure or report. `packages/auth/test/headless-auth-profile-recipe.test.ts`
runs these fixtures through `urlcode test --host-file` against the real
extensions composed as above, and keeps a direct client test of the same flow.

`urlcode audit --expect-routes 3` reports the recipe ready. These fixtures
cover every `/account/*` and `/api/profile/*` method. `/assets/ui/*` serves
only content-hashed file names, which no fixture can know ahead of time; ui
declares it an asset mount, so audit asks it for an unknown name, expects 404
with no cookie, and lists its `GET` and `HEAD` under
`extensionAssetRouteMethods` (see
[extension asset mounts](../../docs/READINESS.md#extension-asset-mounts)).

## Limits

- `mail()` with no transport on a public origin sends nothing, so email
  verification, password reset and email codes are off; pass a transport
  (`mail({transport, from})`) for them.
- Auth runs on the self-hosted Node runtime only, with a patched SQLite build;
  the store writes local files, one server process per data directory.
- This recipe demonstrates a composition. It is not an independent security
  review or a production readiness claim.
