# @jimhoyd/urlcode-auth

Operator-installed authentication for URLCode. Accounts, passwords, sessions,
cookies and their tables are [Better Auth](https://better-auth.com/)'s; this
extension serves one Better Auth instance on one mount and lets routes require
a signed-in user. Released with core and installed with
`urlcode extensions add auth`. Apache-2.0.

It replaced URLCode's own account system (#841, proven in #843). What it does
not do is listed [below](#not-included).

## Add it

```sh
urlcode extensions add auth
npx urlcode-auth migrate
echo '{"email":"you@example.com","password":"a long local password","name":"You"}' | npx urlcode-auth create-user
```

`add` writes `extensions.auth` (empty config), a `/api/auth/*` mount route and
a private `data/auth.secret`, and adds `auth()` to `host.mjs`. `migrate`
creates Better Auth's tables in `data/auth.sqlite`; the extension refuses to
activate until they exist. Both files stay out of the route project; keep them
private and backed up.

```yaml
version: "1"
extensions:
  auth: {version: "1", config: {}}
routes:
  /api/auth/*:
    extension: auth
    methods: [GET, POST]
  /api/me:
    methods: [GET]
    auth: true
    function: {source: functions/me.mjs}
```

## Protect a route

`auth: true` (the short form of `policies.extensions.auth: {}`) requires a
session Better Auth verifies from the request's own cookie. Without one the
route answers `401 {"error":"authentication_required"}`. A `POST`, `PUT`,
`PATCH` or `DELETE` must also come from the site's own origin (`Origin`,
`Sec-Fetch-Site` or `Referer`), or it answers `403 {"error":"cross_origin_refused"}`.

The route's function never receives the cookie or an `Authorization` header.
It receives the verified user id through the request-bound capability:

```js
export default function me(request, context) {
  const { userId } = context.capabilities.auth.identity;
  return Response.json({ userId });
}
```

Test a protected route with a request fixture that signs in through
`POST /api/auth/sign-in/email` inside a `steps` fixture, as a browser does,
with an account `create-user` made for testing; the fixture's cookie jar keeps
the session, and `"origin":"{{origin}}"` passes the same-origin check. There is
no test principal that skips the gate. See
[authenticated routes](../../docs/READINESS.md#authenticated-routes-auth-true).

Identity is not permission. Roles, ownership and approvals are application
data keyed by that id. A `sandbox: true` route cannot name `auth`: the
capability is a live object that cannot cross into the sandbox, so the runtime
refuses it before serving.

## Sign in from the browser

Use Better Auth's own client; the mount is its `basePath`:

```js
import { createAuthClient } from 'better-auth/client';
const auth = createAuthClient({ basePath: '/api/auth' });
await auth.signIn.email({ email, password });
await auth.signOut();
```

The mount forwards only these Better Auth paths; everything else under it is
`404`:

| Path | Purpose |
| --- | --- |
| `POST /sign-in/email`, `POST /sign-out` | Sign in and out |
| `GET /get-session` (or `POST`), `GET /list-sessions` | The current session and the user's sessions |
| `POST /revoke-session`, `/revoke-sessions`, `/revoke-other-sessions` | End sessions |
| `POST /change-password` | Change the signed-in user's password |
| `GET /ok` | Health |
| `POST /sign-up/email` | Only with `auth({signUp: true})` |

## Operator options

Everything about the Better Auth instance is `host.mjs` code, never YAML:

```js
auth({
  signUp: false,          // allow POST /sign-up/email
  paths: [],              // more Better Auth paths to serve, for example a plugin's
  betterAuth: {},         // extra Better Auth options, such as plugins (trusted code)
  database: 'data/auth.sqlite',
  secretFile: 'data/auth.secret',
})
```

`BETTER_AUTH_SECRET` overrides the secret file. The extension always keeps
Better Auth's rate limiter on (10 sign-in attempts per client address a
minute), keyed by the client address URLCode admitted, and telemetry off; the
`betterAuth` option cannot change either. Better Auth's base URL is the
operator's `--origin` and its base path is the mount.

## Not included

- No account pages, admin console, audit events, email flows,
  two-factor, social or OIDC sign-in, API keys or account recovery. Add a
  Better Auth plugin through `betterAuth` and its paths through `paths` when an
  application needs one.
- No role or permission model: keep permissions in the application.
- Node only; aws and vercel refuse it.

See [SECURITY.md](SECURITY.md) for the security model.

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `auth` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** none.

### Configuration: `extensions.auth.config`

No configuration keys: declare `extensions.auth: {version: "1", config: {}}`.

### Route policy: `policies.extensions.auth`

A route may write this as the `auth:` short form: `auth: true` is `{}`.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|


Whole-policy rules: unknown keys rejected.

### Authoring surfaces and limits

Accounts and sessions served by Better Auth on one extension mount. Protect a route with `auth: true`; its function reads the signed-in user id from context.capabilities.auth.identity.userId. Permissions are data keyed by that id, never roles in auth: per-user records and membership lists are store declarations (ownership: owner, membership).

- **mount** (extension, `urlcode.yaml#routes`): Mount Better Auth at one path, for example /api/auth/* with extension: auth and methods [GET, POST]. Only the operator-enabled Better Auth endpoints answer; everything else under it is 404.
- **route protection** (configuration, `urlcode.yaml#routes`): `auth: true` on a route requires a verified Better Auth session and refuses cross-origin unsafe methods; the route receives no cookie or Authorization header. It is the principal-providing policy a store `ownership: owner` mount, `readers` mount or `by: others` transition mount needs.

Fast checks: `urlcode validate --project app`, `urlcode validate --local --project app --host-file host.mjs --origin <origin>`.
<!-- extension-reference:end -->
