# Private requests: embedded Better Auth proof

This is the bounded proof for [#843](https://github.com/jimhoyd-com/urlcode/issues/843),
the first gate of the ecosystem-reuse plan in
[#841](https://github.com/jimhoyd-com/urlcode/issues/841). It is one locally
runnable URLCode site. [Better Auth](https://better-auth.com/) owns accounts,
passwords, sessions and its own SQLite tables. URLCode owns the declared
routes, the admission decision and the review facts. The first-party
[`auth` extension](../../packages/auth/README.md) (`@jimhoyd/urlcode-auth`)
connects the two, and the first-party
[`store` extension](../../docs/STORE.md) (`@jimhoyd/urlcode-store`) holds the
application's data and serves its one business rule from YAML. There is no
application server code. It is not a starter or a release claim.

- Two synthetic owners and one reviewer. Owners create, list and read only
  their own requests (an owned store collection). A reviewer can read any
  request and approve another user's pending one. Signing in never grants
  review: that permission is application data, a store
  [membership collection](../../docs/STORE.md#membership-gates-and-cross-owner-reads)
  keyed by Better Auth's opaque user id.
- Sign-in, sign-out, "sign out everywhere" and session checks are Better
  Auth's own endpoints and browser client. There is no URLCode session, cookie
  or password code here.
- Application routes are `extension: store` mounts marked `auth: true`. The
  store receives the verified user id as the request principal, never a cookie
  or header, and scopes, gates and stamps with it.

| Route | What the store serves |
|---|---|
| `GET /api/requests`, `GET /api/requests/<id>`, `POST /api/requests` | The caller's own requests (`?status=pending` or `approved` filters); another owner's is `404` |
| `POST /api/approvals/<id>` | The `approve` transition: `pending` to `approved`, stamping `reviewedAt`; members of `reviewers` only, never on their own request |
| `GET /api/review`, `GET /api/review/<id>` | Every owner's requests, read-only, for members of `reviewers`; `?status=pending` is the queue |

## Layout

| Path | Owner | What it is |
|---|---|---|
| `operator/auth.mjs` | operator | This proof's Better Auth choices beyond the package defaults: app name, `disabledPaths`, and the data directory |
| `host.mjs` | operator | Composes the host with `auth({database, secretFile, betterAuth})` |
| `scripts/setup.mjs` | operator | Forward schema setup, synthetic accounts, and the reviewer's membership (the store's `addMember`) |
| `scripts/inventory.mjs` | operator | Pinned versions and the probed endpoint list |
| `app/urlcode.yaml` | application | Every route, protection, collection and the approval transition |
| `client/main.js`, `app/public/` | application | The frontend and its Better Auth client |

The frontend is one page, so it is an exact `/` `page` plus an `/assets/*`
mount. A frontend with more files at the site root can instead be one root
`/*` `static` mount beside the `/api/...` extension mounts: each extension
keeps its whole mount, since the longest mount prefix wins
([site-root frontend](../../docs/ROUTING.md#a-site-root-frontend-beside-api-extension-mounts)).
A route inside an extension's mount, such as `/api/requests/export`, is
refused by `urlcode validate`, which names both routes.

The secret file (`data/auth.secret`), the Better Auth database
(`data/auth.sqlite`), the store database (`data/store.sqlite`), the exact allowlist of served Better Auth paths, rate
limiting and the client-address header are the package's defaults. The
committed site depends on `file:../../packages/auth` and
`file:../../packages/store`; a real site gets them from
`urlcode extensions add auth store`, which installs them at core's pins and
writes the mount and secret. `urlcode extensions list` then reports both as
catalog extensions, and `urlcode validate --project app` checks the declaration
against its schemas without loading any host code.

Provider settings and database paths never appear in `app/urlcode.yaml`:
`host.mjs` chooses both databases.

## Run it

It needs a packed build of this checkout: the auth extension is newer than the
latest published runtime. From the repository root:

```sh
npm ci && npm run build && npm run build:addons
npm pack --pack-destination /tmp/urlcode-pack
(cd packages/auth && npm pack --pack-destination /tmp/urlcode-pack)
(cd packages/store && npm pack --pack-destination /tmp/urlcode-pack)
cp -R proofs/private-requests /tmp/private-requests && cd /tmp/private-requests
npm install /tmp/urlcode-pack/jimhoyd-urlcode-0*.tgz /tmp/urlcode-pack/jimhoyd-urlcode-auth-*.tgz /tmp/urlcode-pack/jimhoyd-urlcode-store-*.tgz
npm run build     # bundles the Better Auth browser client into app/public/assets/app.js
npm run setup     # data/ for npm start: auth.secret, auth.sqlite (Better Auth schema), three accounts, store.sqlite with rita as a reviewer
npm run inventory # the Better Auth version, integrity and every endpoint, probed
```

Installation and the client build use the network. Nothing after them does:
the auth extension always turns Better Auth telemetry off.

Review `app/`, `host.mjs` and `operator/`, then approve the revision yourself.
Nothing computes or repins it for you:

```sh
npm run -s proposal > operator/policy.json   # the reviewed projectSha256
npm run validate
npm test          # declarative fixtures, including a signed-in owner, foreign owner and reviewer flow
npm run audit     # ready: every route and method covered, the auth: true ones by signed-in steps
npm start         # http://localhost:4180
```

`npm test` and `npm run audit` need no `setup` and never touch `data/`: each
run starts from a fresh, empty database holding only the three accounts and the
reviewer membership `app/tests/seed.json` declares, and discards it afterwards,
so a rerun behaves exactly like the first run (see
[test data and seeds](../../docs/READINESS.md#test-data-and-seeds)).

An authoring agent gets the same context from the operator's flags, with no
`PROJECT_SHA256` export: `npx urlcode bootstrap --policy operator/policy.json
--origin http://localhost:4180` prints complete commands, and the MCP server
started as below validates, tests and audits through its runners:

```sh
npx urlcode mcp --project app --allow-authoring --host-file host.mjs --origin http://localhost:4180 --policy operator/policy.json
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

The fixtures sign in the way the browser does: a `steps` fixture posts to
`/api/auth/sign-in/email` with a synthetic account, its cookie jar keeps
Better Auth's session cookie, and the later steps read, create, approve and
sign out as that user. No fixture key or header grants an identity. Unsafe
requests send `"origin":"{{origin}}"`, the site origin of the run, so the same
file is ready under any `--origin`; the end-to-end check audits it under a
second one. See
[authenticated routes](../../docs/READINESS.md#authenticated-routes-auth-true).

## What it refuses

- Starting before `npm run setup`: no secret, or Better Auth's tables are not
  initialized. Better Auth's `baseURL` and `basePath` come from `--origin` and
  the declared mount, so they cannot disagree with what URLCode serves.
- Any revision the operator policy does not pin, and a `sandbox: true` route
  that names `auth`: a live capability cannot enter the sandbox.
- AWS, Vercel, Cloudflare and static targets: both extensions declare `node`
  only.
- A non-reviewer on the approval or review mount: one `403
  membership_required`, whether or not the request id exists, before any
  request is read. A reviewer approving their own request (`403
  own_record_refused`), an approval of a request that is no longer pending
  (`409 transition_conflict`; of concurrent approvals exactly one wins), and
  any body that names the owner or `status` (`422 invalid_record`).
- Every Better Auth path outside the package's allowlist (sign-in, sign-out,
  the session endpoints, `/change-password` and `/ok`; sign-up stays off).
  Better Auth's own `disabledPaths`, set in `operator/auth.mjs`, matches
  literal paths, so parametric routes such as `/callback/:id` stay routed
  inside Better Auth; the mount's exact allowlist answers 404 before the
  request reaches it.
- Unsafe methods on application routes without a same-origin `Origin`,
  `Sec-Fetch-Site` or `Referer`. Better Auth applies its own origin check to
  its endpoints.
- Sign-in floods. Better Auth enables its limiter only under
  `NODE_ENV=production`, and without a client address it puts every client in
  one bucket. The extension always enables it and supplies the address URLCode
  admitted in a header it always overwrites; sign-in allows 10 attempts per
  address a minute.

## A second provider

[`../private-requests-authjs`](../private-requests-authjs/README.md) runs this
application with Auth.js, an independently owned library, in place of Better
Auth, through an independent extension package and no core change. It records
what stayed identical, what the client and operator had to change, what Auth.js
cannot do here (no server-side revocation) and where core keys on the name
`auth`.

## Limits

- The authoring MCP runners pass their child process only `PATH`, so a server
  they start uses the site's own `data/`, whatever `PRIVATE_REQUESTS_DATA` says
  (their `run_tests`, like `npm test`, uses a fresh database of its own).
- Reviewer membership is maintained by the operator (`addMember` in
  `scripts/setup.mjs`; `urlcode-store members add|remove|list` is the same
  operation from the command line). The proof does not install the audit
  extension, so neither membership changes nor approvals leave an audit event
  (with audit installed, `audit: true` on `reviewers` records
  `store.membership.added`/`removed`, and on `requests`
  `store.record.transitioned` with the reviewer as actor).
- The review queue does not declare `readers.showOwner`, so a reviewer sees
  what was requested but not by whom; with it, each record carries the
  owner's opaque user id as `_owner` on the review mount only.
- Requests cannot be edited or withdrawn: the route admits `GET` and `POST`
  only, and `approve` is the one transition.
