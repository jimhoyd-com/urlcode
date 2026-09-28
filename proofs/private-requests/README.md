# Private requests: embedded Better Auth proof

This is the bounded proof for [#843](https://github.com/jimhoyd-com/urlcode/issues/843),
the first gate of the ecosystem-reuse plan in
[#841](https://github.com/jimhoyd-com/urlcode/issues/841). It is one locally
runnable URLCode site. [Better Auth](https://better-auth.com/) owns accounts,
passwords, sessions and its own SQLite tables. URLCode owns the declared
routes, the admission decision and the review facts. The application owns one
business rule. It is not a starter, a supported extension or a release claim.

- Two synthetic owners and one reviewer. Owners create, list and read only
  their own requests. A reviewer can read any request and approve another
  user's pending one. Signing in never grants review: that permission is an
  application table keyed by Better Auth's opaque user id.
- Sign-in, sign-out, "sign out everywhere" and session checks are Better
  Auth's own endpoints and browser client. There is no URLCode session, cookie
  or password code here.
- Application routes are ordinary trusted `function` routes. They receive the
  verified user id through the request-bound capability from #840
  (`context.capabilities['better-auth'].identity`), never a cookie or header.

## Layout

| Path | Owner | What it is |
|---|---|---|
| `operator/better-auth-extension.mjs` | operator | The adapter: one mount, one principal gate, one capability |
| `operator/auth.mjs` | operator | Better Auth options: secret, database, enabled endpoints |
| `host.mjs` | operator | Builds the instance and composes the host |
| `scripts/setup.mjs` | operator | Forward schema setup and synthetic accounts |
| `scripts/inventory.mjs` | operator | Pinned versions and the probed endpoint list |
| `app/urlcode.yaml` | application | Every route, input bound and protection |
| `app/functions/*.mjs`, `app/lib/requests.mjs` | application | The business rules and parameterized SQL |
| `client/main.js`, `app/public/` | application | The frontend and its Better Auth client |

Provider settings never appear in `app/urlcode.yaml`. The application database
path reaches the functions only through an `APP_DATABASE` binding, which the
operator policy must grant for the reviewed revision.

## Run it

It needs a packed build of this checkout: the request-bound capability is
newer than the latest published runtime. From the repository root:

```sh
npm ci && npm run build
npm pack --pack-destination /tmp/urlcode-pack
cp -R proofs/private-requests /tmp/private-requests && cd /tmp/private-requests
npm install /tmp/urlcode-pack/jimhoyd-urlcode-*.tgz
npm run build     # bundles the Better Auth browser client into app/public/assets/app.js
npm run setup     # data/: generated secret, auth.db (Better Auth schema), app.db, three accounts
npm run inventory # the Better Auth version, integrity and every endpoint, probed
```

Installation and the client build use the network. Nothing after them does:
Better Auth telemetry is off and the adapter refuses to start if it is not.

Review `app/`, `host.mjs` and `operator/`, then approve the revision yourself.
Nothing computes or repins it for you:

```sh
npm run -s proposal > operator/policy.json   # the requested APP_DATABASE grants and projectSha256
npm run validate
npm test          # declarative fixtures, including a signed-in owner, foreign owner and reviewer flow
npm run audit     # every route and method covered
npm start         # http://localhost:4180
```

Sign in as `ann@example.test` / `ann-local-demo-password`,
`bob@example.test` / `bob-local-demo-password` or the reviewer
`rita@example.test` / `rita-local-demo-password`. They are synthetic local
accounts that `setup` creates.
Any change to `app/` changes the revision; `validate` then refuses until you
review and regenerate `operator/policy.json`.

The repository's end-to-end check does all of the above in a temporary
directory and exercises every success and failure case over HTTP:
`npm run build && npm run test:proof`.

## What it refuses

- Starting before `npm run setup` (no secret, or Better Auth's schema is not
  initialized), a `SITE_ORIGIN` that differs from `--origin`, a mount path
  that differs from Better Auth's `basePath`, and telemetry left enabled.
- Any revision the operator policy does not pin, and a `sandbox: true` route
  that names `better-auth`: a live capability cannot enter the sandbox.
- AWS, Vercel, Cloudflare and static targets: the adapter declares `node` only.
- Every Better Auth path not listed in `operator/auth.mjs`. Better Auth's own
  `disabledPaths` matches literal paths, so parametric routes such as
  `/callback/:id` stay routed inside Better Auth; the adapter's exact
  allowlist answers 404 before the request reaches it.
- Unsafe methods on application routes without a same-origin `Origin`,
  `Sec-Fetch-Site` or `Referer`. Better Auth applies its own origin check to
  its endpoints.
- A Better Auth instance without rate limiting. Better Auth enables its
  limiter only under `NODE_ENV=production`, and without a client address it
  puts every client in one bucket. The adapter requires `rateLimit.enabled`
  and supplies the address URLCode admitted in a header it always overwrites;
  sign-in allows 10 attempts per address a minute.

## Limits

- `npm test` and `npm run audit` sign in and create records in the same
  `data/` directory the site serves. Point `PRIVATE_REQUESTS_DATA` at another
  directory, and run `npm run setup` there, to keep them apart.
- The authoring MCP server accepts no `--policy`, so its `run_validate` and
  `run_test` tools refuse this site's `APP_DATABASE` binding. Its read-only
  tools work.
- The approval transition is one conditional SQL statement. Transactions
  across several records, idempotent retries and audit evidence belong to
  [#835](https://github.com/jimhoyd-com/urlcode/issues/835).
- A trusted route's grant digest covers its entry file, not
  `app/lib/requests.mjs`. `urlcode report` still lists that file as changed code.
