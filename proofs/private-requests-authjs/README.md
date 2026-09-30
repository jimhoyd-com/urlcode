# Private requests with Auth.js: a second auth provider

This is the auth-replaceability check for
[#841](https://github.com/jimhoyd-com/urlcode/issues/841): the
[private-requests application](../private-requests/README.md) with
[Auth.js](https://authjs.dev/) (`@auth/core`) in place of Better Auth. Auth.js
is independently owned and has a materially different model: a
framework-neutral `Request`/`Response` handler, a double-submit CSRF token on
every form post, encrypted JWT session cookies, and no user or password
storage of its own. It is connected by an **independent extension package**,
[`../authjs-provider`](../authjs-provider/extension.js)
(`@example/urlcode-authjs`), installed from a local tarball. Core has no
provider-specific code for it, and nothing here imports
`@jimhoyd/urlcode-auth`, Better Auth or their types. It is a proof, not a supported provider or a release claim.

## What is the same

The store declaration (collections, ownership, the `approve` transition, the
`reviewers` membership, the review mount), the six routes apart from their
descriptions (protection included: `auth: true`), the page and its stylesheet are
identical to the Better Auth proof;
`test/authjs-provider.integration.ts` asserts that. The store never learns
which provider signed the caller in: the provider's `authorize()` sets the
request principal (`request.setPrincipal({id})`), and the store scopes, gates
and stamps with it. A trusted route that names the provider gets the same
`identity` capability, `{userId}`.

Owner privacy, reviewer-only reads, the approval gate (`403
membership_required`, `403 own_record_refused`, exactly one of concurrent
approvals wins), malformed-body refusals, cross-origin refusal on protected
routes, the refusal of a `sandbox: true` route that names the provider, and the
revision pin all behave as in the Better Auth proof, with the same status codes
and error bodies.

## What changed, and why

| Change | Where | Why |
|---|---|---|
| A handler reads `context.capabilities.authjs.identity.userId`, not `.auth.` | route code (this app has none) | The capability namespace is the extension's name |
| The mount is `extension: authjs` and carries `policies.throttle` | `app/urlcode.yaml` | Auth.js has no rate limiter; URLCode's declared throttle bounds sign-in attempts per client address (60 requests a minute across the mount) |
| The operator passes Auth.js's own configuration (the Credentials provider, JWT session lifetime) | `host.mjs`, `operator/auth.mjs` | Provider-specific API, kept as Auth.js defines it; the extension sets only `basePath` (the mount), `secret` and `trustHost` |
| Passwords are checked by operator code: scrypt hashes in `data/users.json` | `operator/users.mjs`, `scripts/setup.mjs` | Auth.js's Credentials provider delegates `authorize()` to the application; it owns no users |
| Sign-in and sign-out call Auth.js's endpoints with `fetch`: a CSRF token, a form post, `X-Auth-Return-Redirect: 1` | `client/main.js` | `@auth/core` has no framework-neutral browser client |
| "Sign out everywhere" is hidden | `client/main.js` | Not available; see gaps |
| The fixtures fetch `/api/auth/csrf` before each sign-in and sign-out, and capture `authjs.session-token` | `app/tests/requests.json` | Different endpoints and cookie |

## Gaps: what Auth.js does not do here

- **No server-side revocation.** Auth.js refuses a database session strategy
  with the Credentials provider, so a session is an encrypted JWT in a cookie.
  Sign-out clears the browser's cookie; a copy of it stays valid until it
  expires. The integration test records this: a replayed, signed-out token is
  still admitted (`200`), where the Better Auth proof answers `401`.
  `operator/auth.mjs` bounds it with a one-hour `maxAge`. Auth.js's `jwt`
  callback could consult a denylist, but that would be revocation built in
  the application, which this proof does not do.
- **No "sign out everywhere", session list or password change.** Those are
  Better Auth endpoints with no Auth.js equivalent for credentials sign-in.
- **No accounts.** Sign-up, reset, lockout and hashing parameters are the
  application's. `operator/users.mjs` is the minimum for three synthetic
  accounts, not an account system.
- **Coarser throttling.** The declared throttle counts every request to the
  mount, not only sign-in attempts, and it is per process and in memory.
- **No endpoint inventory.** Auth.js's action names are fixed, not probed; the
  mount forwards `/csrf`, `/session`, `/providers`, `/callback/credentials`
  and `/signout` and answers 404 for the rest, including Auth.js's built-in
  HTML pages and OAuth callbacks.

## How protection finds the provider

The protected routes say `auth: true`, exactly as in the Better Auth proof.
The short form names a role, not a package: it expands to the one declared
extension whose `urlcode.json` declares `providesPrincipal: true`, here
`policies.extensions.authjs: {}`
([extensions](../../docs/EXTENSIONS.md#protecting-a-route-the-auth-short-form)).
The expansion is part of the reviewed project revision, so `explain` shows
`extensions.authjs`, and `urlcode openapi` gives a route it gates the `401` and
`403` answers; since `authjs` declares no `openapiSecurity`, the operation
states its transport as unknown (`x-urlcode.authentication`) rather than
inventing a cookie
([OpenAPI export](../../docs/TOOLING.md#openapi-export)). `urlcode review`'s
session-cookie hint names `authjs`. The first-party name `auth` stays reserved:
`urlcode extensions add` refuses an independent package that names itself
`auth` (the test shows the refusal), and nothing here needs it.

## Run it

It needs a packed build of this checkout, like the Better Auth proof. From the
repository root:

```sh
npm ci && npm run build && npm run build:addons
npm pack --pack-destination /tmp/urlcode-pack
(cd packages/store && npm pack --pack-destination /tmp/urlcode-pack)
(cd proofs/authjs-provider && npm pack --pack-destination /tmp/urlcode-pack)
cp -R proofs/private-requests-authjs /tmp/private-requests-authjs && cd /tmp/private-requests-authjs
npm install /tmp/urlcode-pack/jimhoyd-urlcode-0*.tgz /tmp/urlcode-pack/jimhoyd-urlcode-store-*.tgz /tmp/urlcode-pack/example-urlcode-authjs-*.tgz
npm run build     # copies client/main.js to app/public/assets/app.js
npm run setup     # data/: authjs.secret, users.json (three synthetic accounts), store.sqlite with rita as a reviewer
npm run -s proposal > operator/policy.json   # review, then approve the revision yourself
npm run validate && npm test && npm run audit   # audit is ready: the auth: true routes are covered by signed-in steps
npm start         # http://localhost:4180
```

The accounts are the Better Auth proof's: `ann@example.test`,
`bob@example.test` and the reviewer `rita@example.test`, with passwords
`<name>-local-demo-password`. `npm test` and `npm run audit` give the store a
fresh database each run, holding rita's reviewer membership from
`app/tests/seed.json`; this Auth.js provider is not a first-party extension, so
it still checks passwords against the `data/users.json` that `setup` writes
(read only, with the fixed ids `ann`, `bob` and `rita` the seed names). In a new site the provider installs with
`urlcode extensions add ./example-urlcode-authjs-0.1.0.tgz`, which locks it by
integrity, writes `extensions.authjs`, the `/api/auth/*` mount and
`data/authjs.secret`, and adds it to `host.mjs`; activation then refuses until
the operator passes Auth.js providers.

The repository's end-to-end check does all of this in a temporary directory
and exercises every case over HTTP: `npm run build && npm run test:proof:authjs`.
Installation needs the npm registry for `@auth/core`; nothing after it does.
