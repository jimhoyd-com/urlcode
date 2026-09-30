# Authenticated JSON API

`/api/profile` is a function behind `auth: true`, the route-level short
form that expands to `policies.extensions.auth: {}`. The project declares the
`auth` extension; it never chooses or loads the module that implements it.
Authorization happens in trusted operator code before the route's function
runs: the auth extension (Better Auth) admits a request only with a verified
session and hands the function the signed-in user's id as
`context.capabilities.auth.identity.userId`. The host strips `Authorization`
and `Cookie` before dispatch, for trusted and `sandbox: true` routes alike, and
a `sandbox: true` route cannot name `auth` at all.

## The host file

The recipe does not activate on its own. In a site, `urlcode extensions add
auth` installs the extension and registers it in `host.mjs`, outside the
project; see [the auth package][packages/auth/README.md]:

```js
// host.mjs -- trusted operator code, outside app/
import {composeHost} from '@jimhoyd/urlcode/host';
import auth from '@jimhoyd/urlcode-auth/extension';

export default await composeHost(import.meta.url, [auth()]);
```

The auth extension serves exactly one mount, so the recipe carries it:
`routes/auth.yaml`, included from `urlcode.yaml`, is the file
`urlcode extensions add auth` writes. In a site created with
`urlcode init <site>` and `urlcode extensions add auth`,
`urlcode recipes add authenticated-json-api --project app` merges the route,
`functions/profile.mjs`, the fixtures and the seed into `app/` (the site's
`routes/auth.yaml` is the same file) and moves `expectRoutes` in
`app/tests/audit.json` to 2.

## The local loop

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --local-review
urlcode test --project . --host-file /operator/host.mjs --local-review
urlcode audit --project . --expect-routes 2 --host-file /operator/host.mjs --local-review
```

`--local-review` pins the host to the project's current revision for that one
run, on `http://localhost`, and reads no operator policy
([the local review loop][docs/EXTENSIONS.md#the-local-review-loop]). `test`
and `audit` run on a fresh, throwaway auth database and create the account
the fixtures sign in as, `ada`, from `tests/seed.json` (`auth.users`); use
synthetic accounts only. The fixtures sign in through the extension's own
`POST /api/auth/sign-in/email`, whose cookie jar keeps the session for the
later steps, then read the profile, sign out and are refused again. The asserted
sign-in and `GET /api/auth/get-session` cover the auth mount, which the audit
counts like any route ([authenticated routes][docs/READINESS.md#authenticated-routes-auth-true]).

## Serving and the review gate

`urlcode serve` and `urlcode dev` need the project revision the operator
reviewed, never one the host recomputes. Review the project, print its revision
once and keep it outside the project:

```sh
urlcode extensions --project .     # prints "Project revision: <sha256>"
```

Supply it as `PROJECT_SHA256=<sha256>` or through a reviewed operator policy
(`urlcode permissions --project . > /operator/api-policy.json`, then
`--policy`), with the public `--origin`. Editing `urlcode.yaml` or the function
changes the revision, so a pinned command then refuses with `Extension
revision pin mismatch: auth` until the operator reviews the change
([the revision pin][docs/EXTENSIONS.md#the-revision-pin]). Before serving,
create the accounts: `npx urlcode-auth migrate`, then
`npx urlcode-auth create-user`.

`auth: true` is the whole requirement: the auth policy has no role or
permission keys. Roles, ownership and approvals are application data keyed by
the user id; the store keeps them with no handler code (the store-approval
recipe, and the end-to-end application in
[`proofs/private-requests`][proofs/private-requests/README.md]). See
[extensions][docs/EXTENSIONS.md].

Edit `functions/profile.mjs` to return real data. Cloudflare refuses extensions;
functions need the self-hosted runtime.

<!-- x-release-please-start-version -->
[packages/auth/README.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/packages/auth/README.md
[docs/EXTENSIONS.md#the-local-review-loop]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-local-review-loop
[docs/READINESS.md#authenticated-routes-auth-true]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md#authenticated-routes-auth-true
[docs/EXTENSIONS.md#the-revision-pin]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-revision-pin
[docs/EXTENSIONS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md
[proofs/private-requests/README.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/proofs/private-requests/README.md
<!-- x-release-please-end -->
