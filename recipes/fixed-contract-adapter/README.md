# Fixed-contract adapter

A pre-existing JSON API (a mobile app, a frontend you cannot change, a
benchmark) often fixes its paths, field names and error codes. This recipe
serves as much of such a contract as URLCode can serve safely, and says which
parts the client has to change and why.

The adapter is a small operator module, `api-contract.mjs`, beside `host.mjs`.
It reads the signed-in account through auth's public exports and keeps the
caller's items through the store's public records export, then projects both
to the contract's shape. Passwords, sessions, cookies, CSRF and origin checks
belong to auth. Records and ownership belong to the store. The adapter never
reads a cookie, never checks a password or a token, never starts or ends a
session and never compares owners. If a contract seems to need one of those,
report it as a gap. Do not add code for it.

This is not a new runtime feature and not generic response rewriting. It is
one trusted module over two versioned exports
([`AuthExports`](../../packages/auth/src/exports.ts),
[`StoreExports`](../../packages/store/src/records.ts)), composed the way the
[form-records](../../packages/form-records/README.md) extension composes forms
and store ([issue #828](https://github.com/jimhoyd-com/urlcode/issues/828)).

## The contract, and what this recipe serves

The typical fixed contract this recipe measures against:

| Contract | Served here | How |
|---|---|---|
| `POST /api/login {email, password}` → `200 {email, role}` | **No: the client adapts** | `GET /account/csrf`, then `POST /account/login` with `X-CSRF-Token`: `200 {user, csrf}` and auth's session cookie. Then `GET /api/me` for `{email, role}`. |
| `GET /api/me` → `200 {email, role}` | Yes | The adapter projects `AuthExports.account(request)`. The session-bound CSRF token is also sent as the `X-CSRF-Token` response header, so the body keeps its shape. |
| `POST /api/logout` → `204` | **No: the client adapts** | `POST /account/logout` with `X-CSRF-Token`: `200 {signedOut: true}`, the session is revoked and its cookie cleared. |
| `GET /api/items` → `200 [{id, title, done}]` | Yes | `StoreExports` `list`, every page, only the caller's records. |
| `POST /api/items {title, done?}` → `201 {id, title, done}` | Yes | `StoreExports` `create`, with `Location: /api/items/<id>`. |
| `GET /api/items/<id>` → `200 {id, title, done}` | Yes | `StoreExports` `get`. Another user's item is `404`, like a missing one. |
| `PATCH /api/items/<id>` → `200 {id, title, done}` | Yes | `StoreExports` `update`. `null` removes an optional field. |
| `DELETE /api/items/<id>` → `204` | **No: the client adapts** | `StoreExports` version 1 has no delete. The contract route answers `405 METHOD_NOT_ALLOWED`. The store's native `DELETE /store/items/<id>` deletes the same record under the same ownership. |
| Errors as `{error: {code, message}}` | Partly | Adapter and runtime errors use the envelope. Auth's `401` and `403` do not (see the audit). |

## Compatibility audit

What a fixed contract can map through the public APIs, and what is
deliberately unsupported. "Client adapts" means the client must change, because
serving the contract as written would mean bypassing or re-implementing
something auth or the store owns.

### Safe with the public APIs

| Transformation | Why it is safe | Where |
|---|---|---|
| **Path aliasing by mount prefix.** Choose where auth and the store answer. | The route key is the mount (`/account/*`, `/store/items/*`). Auth's endpoint names under it (`/login`, `/logout`, `/csrf`, `/account`) are fixed. Two extension mounts cannot overlap, so auth at `/api/*` excludes every other `/api/...` route. | `packages/core/src/router.ts` (`Extension mount overlaps another route`), [auth JSON contract](../../packages/auth/docs/JSON-API.md) |
| **Path aliasing through an adapter mount.** `/api/me`, `/api/items` served by operator code that calls the exports. | The adapter mounts carry `auth: true`, so auth's `authorize()` checks the session, enforces CSRF and origin on writes and sets the principal before `handle()` runs. The adapter refuses to activate on a mount without that policy (`principalMounts`). | `packages/auth/src/auth.ts` (`authorize`), [request principal](../../docs/EXTENSIONS.md#request-principal) |
| **Projection of non-secret account fields.** `{email, role}` from `AuthAccount`. | `AuthExports.account(request)` returns a frozen account (`id`, `email`, `emailVerified`, `roles`, `permissions`, ...) for a request auth's own session policy authorized, and `null` otherwise. It holds no token, hash or cookie. `role` is `roles[0]`: a contract with one role per user loses nothing, and one with several gets the first. | `packages/auth/src/exports.ts` (`account`, `accountOf`) |
| **Handing a client the CSRF token outside the body.** | `AuthExports.csrf.token(request)` is the same session-bound token auth returns from `/account/login` and `/account/account`. A same-origin client can already read it there; a cross-origin page cannot read a response header without CORS. | `packages/auth/src/exports.ts` (`csrf.token`) |
| **Owner-scoped CRUD through the records export.** | `StoreExports.records(name)` applies the HTTP API's rules: validation, bounds, `maxRecordsPerOwner`, and ownership from the principal the caller passes. The adapter passes `request.principal`, which only auth can set. The owner is never in a result. Another owner's record throws the same `404 not_found` as a missing id. | `packages/store/src/records.ts` |
| **Projection of record fields.** `{id, title, done}` instead of `{id, createdAt, updatedAt, title, done}`. | Declared, non-secret fields only; the stored owner is already hidden. The adapter accepts only the configured fields and refuses any other key, such as `createdAt` or an owner, with `400`. | `packages/store/src/records.ts` (`view`) |
| **Mapping store and body errors to the contract's codes.** | Store failures are `StoreError`s with the HTTP status, code and field names, never values. Body refusals are `ExtensionHttpError`s with fixed messages. The adapter keeps the status and writes a fixed code and message per status. | `packages/store/src/collection.ts` (`StoreError`), `packages/core/src/extension-http.ts` (`readBody`) |
| **The same envelope for runtime errors.** An unmatched `/api/...` path, an undeclared method. | `site.errors: {format: json, paths: [/api/*]}` makes the runtime's own 404, 405, 413 and 5xx answers `{error: {code, message}}` with a closed code set. | [HTTP error format](../../docs/HTTP.md#error-format) (#821) |
| **Migrating existing password hashes.** | `urlcode-auth import` (`AuthService.importUsers`) takes bcrypt (cost 10 to 14), PBKDF2-SHA256 (600000 iterations or more) and auth's own scrypt hashes; auth verifies them at sign-in. | `packages/auth/src/auth-core.ts` (`importUsers`, `validPasswordHash`), [auth README](../../packages/auth/README.md) |

### Unsupported, or the client adapts

| Contract requirement | Status | Reason |
|---|---|---|
| **Sign-in at a contract path** (`POST /api/login`) answering `{email, role}` | Client adapts | `AuthExports` has no sign-in. Calling `AuthService.login` from operator code would skip everything auth's `/login` handler does around it: the flow-cookie CSRF check (`http.verify`), the abuse backoff (`backoff.check`/`failure`/`clear`), the device cookie and new-device notice, and the `__Host-urlcode-session` cookie (`http.sessionHeaders`). The adapter would then be minting auth's cookie itself. Use `POST /account/login` (the prefix is the mount you choose). `packages/auth/src/auth.ts` (`/login`), `packages/auth/src/auth-ui.ts` (`sessionHeaders`). |
| **Sign-out at a contract path** (`POST /api/logout`) | Client adapts | `AuthExports` has no sign-out. `administration.sessions.revoke` needs `auth.sessions.manage` and a reason, and clearing the cookie is auth's (`http.clearSession`). Use `POST /account/logout`. |
| **Sign-in without a CSRF step**, or a write without the token or a site `Origin` | Unsupported | Every write to auth's mount needs the flow- or session-bound token and a site origin (`http.verify`). A write to a route with `auth: true` needs the token too (`verifyWrite`); `auth: {csrf: origin}` drops only the token, and only belongs on a JSON-only mount like this adapter's. No option drops the origin check on a cookie session. `packages/auth/src/auth-ui.ts` (`verify`, `verifyWrite`), [CSRF on protected routes](../../docs/EXTENSIONS.md#csrf-on-protected-routes-csrf-token--origin). |
| **The contract's error body on `401` and `403`** from a protected route | Client adapts: key on the status | Auth's `authorize()` answers `{error: "<localized message>"}` before the adapter runs. #821's `site.errors` never rewrites an extension's answer or denial, and an extension's `middleware()` wraps only what runs after `authorize()`. `onDeny` changes the status, not the body. The statuses themselves match the contract (`401` signed out or revoked, `403` a missing token or foreign origin). `packages/auth/src/auth.ts` (`authorize`), [HTTP error format](../../docs/HTTP.md#error-format). |
| **A session in a header** (login returns a token, the client sends `Authorization: Bearer`) | Unsupported | Auth's sessions travel only in the `__Host-urlcode-session` cookie. `bearer` accepts operator-issued API keys (`urlcode-auth api-key-issue`, optionally acting for a user with `userId`), not a token from sign-in, and a route is either session or bearer, never both. `AuthExports.account()` is `null` for a bearer principal, so `/api/me` cannot answer one. [Bearer/API-key routes](../../docs/EXTENSIONS.md#bearerapi-key-routes). |
| **Password hashes, session tokens, the CSRF key, a record's owner** in a response | Unsupported | No public API returns them: `AuthUser` has no hash, `AuthAccount` no token, and the store strips `_owner`. Auth's account `id` is not secret and could be projected; this contract has no field for it. |
| **Cross-owner access** (an administrator lists or edits everyone's items) | Unsupported | An owned collection scopes every export call to the principal; there is no "all owners" call. Reading through a shared collection and filtering in the adapter would re-implement authorization. Another user's item is `404`; a contract that wants `403` there would reveal that the item exists. |
| **Delete through the contract path** | Gap | `StoreExports` version 1 has `create`, `get`, `update` and `list`, and no `delete`. The native store mount deletes the record. |
| **Replace (`PUT`) through the contract path** | Not in this recipe | `update` is a partial update. A full replace can be expressed as `update` with `null` for each omitted optional field; this contract does not use `PUT`. The native store mount has `PUT`. |
| **Custom or unsalted password hashing**, such as a plain SHA-256 seed helper | Unsupported | `importUsers` refuses any other hash format. Seed accounts through registration, `urlcode-auth bootstrap`, or `import` with a supported hash; users with an unsupported hash reset their password. |
| **Registration at a contract path** | Client adapts | As for sign-in: `POST /account/register` after `GET /account/csrf`. |

## Operator setup

In a new site ([site layout](../../docs/EXTENSIONS.md#the-site-layout)):

```sh
npx urlcode init items-api --with ui,auth,store
cd items-api
rm -r app && npx urlcode recipes add fixed-contract-adapter --out app
```

Save the adapter module below as `api-contract.mjs` beside `host.mjs`, and add
it to the host. Open registration in `operator-service.mjs`
(`registrationMode: 'open'`) before the first start; it must match the
project's `registration: open`.

```js
// host.mjs -- trusted operator code, outside app/
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';
import store from '@jimhoyd/urlcode-store/extension';
import apiContract from './api-contract.mjs';

export default await composeHost(import.meta.url, [audit(), mail(), ui(), auth(), store(), apiContract()]);
```

`composeHost` activates `api-contract` after auth and store, because it
`requires` both. The project declares its configuration and mounts; it never
loads the module. Review the project, pin its revision and run from the site:

```sh
npx urlcode extensions --project app --host-file host.mjs   # prints "Project revision: <sha256>"
export PROJECT_SHA256=<the reviewed revision>
npx urlcode validate --local --project app --host-file host.mjs --origin https://api.example.com
npx urlcode test --project app --host-file host.mjs --origin https://api.example.com
npx urlcode audit --project app --expect-routes 5 --host-file host.mjs --origin https://api.example.com
npx urlcode serve --project app --host-file host.mjs --origin https://api.example.com
```

`--host-file` refuses a file inside the project, so the module and the host
stay outside `app/`.

## The adapter module

```js
// api-contract.mjs, beside host.mjs: trusted operator code, never part of the project.
// It serves a fixed JSON contract from auth's and store's public exports only. It never reads a cookie, checks a
// password or a CSRF token, starts or ends a session, or compares owners: auth's policy on its routes has done all of
// that before handle() runs, and the store scopes every call to the principal auth set.
import { defineExtension, ExtensionHttpError, jsonResponse, readBody } from '@jimhoyd/urlcode/extensions';
import { StoreError } from '@jimhoyd/urlcode-store';

const mount = { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 };
const schema = {
  type: 'object', additionalProperties: false, required: ['me', 'items'],
  properties: {
    me: { ...mount, description: 'Mount whose GET answers the signed-in account as {email, role}.' },
    items: {
      type: 'object', additionalProperties: false, required: ['mount', 'collection', 'fields'],
      description: 'Owner-scoped list, create, read and update over one ownership: owner store collection.',
      properties: {
        mount: { ...mount, description: 'Mount serving the items.' },
        collection: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A declared store collection with ownership: owner.' },
        fields: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, description: 'Declared fields the contract reads and writes; no other field is exposed or accepted.' },
      },
    },
  },
};

// The contract's error taxonomy: one fixed code and message per status, never a submitted value or internal detail.
const errors = {
  400: ['VALIDATION_FAILED', 'Request failed validation'], 401: ['UNAUTHORIZED', 'Sign in required'],
  404: ['NOT_FOUND', 'Not found'], 405: ['METHOD_NOT_ALLOWED', 'Method not allowed'], 409: ['CONFLICT', 'Conflict'],
  412: ['CONFLICT', 'Conflict'], 413: ['CONTENT_TOO_LARGE', 'Content too large'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type'], 503: ['SERVICE_UNAVAILABLE', 'Service unavailable'],
};
const failure = (status, headers = []) => jsonResponse(status, { error: { code: errors[status][0], message: errors[status][1] } }, headers);
class Refused extends Error { constructor(status) { super(errors[status][1]); this.status = status; } }
const ID = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function contract(auth, store, config, activation) {
  if (!auth.active || !store.active) throw new Error('api-contract needs auth and store active first (composeHost orders them)');
  const records = store.records(config.items.collection);
  if (records.ownership !== 'owner') throw new Error(`api-contract: collection ${config.items.collection} must declare ownership: owner`);
  for (const field of config.items.fields) if (!Object.hasOwn(records.fields, field)) throw new Error(`api-contract: collection ${config.items.collection} declares no field ${field}`);
  // Fail closed at startup: every contract route must carry auth's session policy, which sets the principal.
  for (const route of [config.me, config.items.mount]) {
    if (!activation.mounts.includes(route)) throw new Error(`api-contract: route ${route}/* with extension: api-contract is not declared`);
    if (!(activation.principalMounts ?? []).includes(route)) throw new Error(`api-contract: route ${route}/* needs auth: true`);
  }
  for (const route of activation.mounts) if (route !== config.me && route !== config.items.mount) throw new Error(`api-contract: mount ${route} is not configured`);

  const fields = config.items.fields;
  const view = record => Object.fromEntries([['id', record.id], ...fields.filter(name => Object.hasOwn(record, name)).map(name => [name, record[name]])]);
  // A JSON object of contract fields only; the store validates each value against its declaration.
  const values = (request, partial) => {
    const { value } = readBody(request, { accept: ['json'], maxBytes: 16384 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refused(400);
    for (const [name, field] of Object.entries(value))
      if (!fields.includes(name) || (field === null ? !partial : !['string', 'number', 'boolean'].includes(typeof field))) throw new Refused(400);
    return value;
  };
  // The contract lists every item at once; maxRecordsPerOwner bounds it, and each page is the store's own.
  const list = principal => {
    const items = [];
    let cursor;
    do { const page = records.list(principal, cursor === undefined ? {} : { cursor }); items.push(...page.items.map(view)); cursor = page.next; } while (cursor !== undefined);
    return items;
  };
  const read = request => request.method === 'GET' || request.method === 'HEAD';

  async function handle(request) {
    const principal = request.principal ?? null;
    if (principal === null) return failure(401);
    const rest = request.path.slice(request.mount.length);
    if (request.mount === config.me) {
      const account = auth.account(request);
      if (account === null) return failure(401);
      if (rest !== '') return failure(404);
      // Projected, non-secret fields only. The session-bound CSRF token rides in a header, so the body keeps its shape.
      return jsonResponse(200, { email: account.email, role: account.roles[0] ?? null }, [[auth.csrf.header, auth.csrf.token(request)]]);
    }
    try {
      if (rest === '') {
        if (read(request)) return jsonResponse(200, list(principal));
        if (request.method !== 'POST') return failure(405, [['allow', 'GET, HEAD, POST']]);
        const { record } = await records.create(principal, values(request, false));
        return jsonResponse(201, view(record), [['location', `${config.items.mount}/${record.id}`]]);
      }
      const id = ID.exec(rest)?.[1];
      if (id === undefined) return failure(404);
      if (read(request)) return jsonResponse(200, view(records.get(principal, id).record));
      if (request.method !== 'PATCH') return failure(405, [['allow', 'GET, HEAD, PATCH']]);
      return jsonResponse(200, view((await records.update(principal, id, values(request, true))).record));
    } catch (error) {
      // Store and body-reader refusals keep their status and take the contract's code; anything else is a 500.
      if ((error instanceof StoreError || error instanceof ExtensionHttpError || error instanceof Refused) && errors[error.status]) return failure(error.status);
      throw error;
    }
  }
  return { handle };
}

export default defineExtension({
  name: 'api-contract',
  description: 'Serves a fixed JSON contract (the signed-in account, owner-scoped items) from the auth and store exports.',
  requires: ['auth', 'store'],
  schema,
  host(context) {
    const auth = context.get('auth'), store = context.get('store');
    if (auth?.version !== 1 || store?.version !== 1) throw new Error('api-contract needs the auth and store export contracts version 1');
    return { registration: {
      name: 'api-contract', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema,
      activate: (config, activation) => contract(auth, store, config, activation),
    } };
  },
});
```

To fit another contract, change the configuration (`me`, `items.mount`,
`items.collection`, `items.fields`), the projection (`view`, the `{email,
role}` object) and the `errors` table. Keep the rest: the activation checks,
the principal passed to every store call, and the refusal of any field the
contract does not name.

## The client protocol

Every request sends `Accept: application/json` and keeps auth's cookies (the
session cookie is `__Host-urlcode-session`: HTTPS, `HttpOnly`,
`SameSite=Strict`, `Path=/`). Every write also sends `Content-Type:
application/json`, `Origin: <the site origin>` and `X-CSRF-Token: <token>`.

1. **Sign in.** `GET /account/csrf` answers `{csrf}` and sets a short-lived
   flow cookie. `POST /account/login {email, password}` with that token
   answers `200 {user, csrf}` and sets the session cookie. A wrong password is
   `401`, and a missing token or foreign origin `403`. Keep the new `csrf`.
2. **Read the account.** `GET /api/me` answers `200 {email, role}` and sends
   the current token as the `X-CSRF-Token` response header. A client that lost
   the token (after a reload) reads it from there.
3. **Items.** `GET /api/items`, `POST /api/items`, `GET /api/items/<id>` and
   `PATCH /api/items/<id>`, each write with the token and the origin.
   `DELETE /store/items/<id>` deletes one, with the same headers.
4. **Sign out.** `POST /account/logout {}` with the token answers
   `200 {signedOut: true}`. The session is revoked, so the old cookie is
   refused with `401` everywhere afterwards.

### Contract statuses and errors

| Case | Status | Body |
|---|---|---|
| Signed out, or a revoked session | `401` | auth's `{error: "<message>"}` |
| A write without the token, with another site's `Origin`, or with none | `403` | auth's `{error: "<message>"}` |
| A field the contract does not name, a missing required field, a wrong type, a non-object body | `400` | `{error: {code: "VALIDATION_FAILED", message: "Request failed validation"}}` |
| Another user's item, a missing item, a malformed id | `404` | `{error: {code: "NOT_FOUND", message: "Not found"}}` |
| A body that is not `application/json` | `415` | `{error: {code: "UNSUPPORTED_MEDIA_TYPE", ...}}` |
| More than `maxRecordsPerOwner` items | `409` | `{error: {code: "CONFLICT", ...}}` |
| `DELETE /api/items/<id>`, or another undeclared method, signed in | `405` with `Allow` | `{error: {code: "METHOD_NOT_ALLOWED", ...}}`, written by the runtime (signed out, auth's `401` comes first) |
| An unmatched `/api/...` path | `404` | `{error: {code: "NOT_FOUND", ...}}`, written by the runtime |

No `/api/*` response sets a cookie. Every one is `Cache-Control: no-store`.

## Native contracts beside it

The adapter adds routes; it changes nothing native. `/account/*` is auth's
full [JSON contract](../../packages/auth/docs/JSON-API.md), and
`/store/items/*` is the store's native API over the same records, with
`createdAt`, `updatedAt`, `PUT`, `DELETE` and `{error: {code, message,
fields?}}` errors ([data store](../../docs/STORE.md)). An item created through
one is visible through the other, under the same ownership. The
[headless-auth-profile](../headless-auth-profile/README.md) recipe is the
native-only version of this composition.

## What the tests cover

`tests/requests.json` holds the signed-out cases (`401` on every protected
route and method, the runtime's JSON `404` for `/api/login`) and one `steps`
fixture for the whole lifecycle, run by one client with its own
[cookie jar](../../docs/READINESS.md#cookies):

1. Ada registers and signs in at `/account/*`, each write carrying the latest
   captured `csrf`; `GET /api/me` answers `{email, role}` and the token header;
2. items are created, listed, read and updated through `/api/items`, with the
   contract's `400`, `404`, `405` and `415` envelopes, and a missing token or
   foreign `Origin` refused with `403`;
3. the same item is read and replaced through the native `/store/items`;
4. Ada signs out, and her old session cookie is refused with `401` on
   `/api/me` and `/api/items`;
5. Bob signs up and in, sees an empty list, and gets `404` for Ada's item on
   both the contract and the native mount;
6. Ada signs in again and deletes her item through the native mount, so the
   fixture runs again against the same operator database.

`packages/auth/test/fixed-contract-adapter-recipe.test.ts` runs the adapter
module exactly as written above against the real extensions: the lifecycle
through a direct client (the session cookie's attributes, the token header
matching the sign-in token, ownership, every error mapping, native and
contract views of the same record, and no cookie from any `/api/*`
response), the activation refusals, the bundled fixtures twice, the
[headless-auth-profile](../headless-auth-profile/README.md) fixtures on the
same auth database, and `urlcode test` and `urlcode audit --expect-routes 5`
through `--host-file`. Audit reports the recipe ready; the `ui` asset mount is
covered as an [extension asset mount](../../docs/READINESS.md#extension-asset-mounts).

## Limits

- The contract is served partly: sign-in, sign-out and delete use native
  paths, and `401`/`403` bodies are auth's. Each is listed in the audit above
  with its reason.
- The list answers every item at once. `maxRecordsPerOwner` bounds it; do not
  remove that bound.
- Auth runs on the self-hosted Node runtime only, with a patched SQLite build;
  the store writes local files, one server process per data directory. The
  adapter declares `targets: ['node']`.
- The adapter is trusted operator code with the host's privileges, like every
  extension. This recipe demonstrates a composition. It is not an independent
  security review or a production readiness claim.
