# Authenticated application handlers

Start here when an application needs custom business rules for the signed-in
user. Auth owns accounts, sessions, sign-in, sign-out, authorization and CSRF.
Each application endpoint is an ordinary YAML function route: its path,
methods, access policy, inputs and body bounds stay visible for review. There
is no custom router or application extension to write.

Prefer an existing declarative handler or extension when it expresses the
requirement. For owner-scoped CRUD, use the
[headless auth/profile recipe](../headless-auth-profile/README.md) and store.
These functions are for behavior those contracts cannot express, not another
implementation of authentication or storage. The example returns identity and
echoes bounded JSON; it supplies no domain rules or persistence layer.

## Create the site

Use the installed runtime and matching auth package that provide
`sessionUserId`. In a new directory:

```sh
npx urlcode init handler-api --with auth --no-mcp
cd handler-api
mv app app-initial
npx urlcode recipes add authenticated-handlers --out app
```

`init` supplies the host, auth and its dependencies, operator service and fresh
private keys. The retained `app-initial` is the original project. The generated `AGENTS.md`
at the site root still supplies the installed authoring guidance.
Before first start, set `registrationMode: 'open'` in `operator-service.mjs`
to match this example's `extensions.auth.config.registration`. Choose the
registration policy appropriate for your application in both places. Changing
an existing auth database's configuration needs the reviewed migration described
in the [auth guide](../../packages/auth/README.md).

Review the project and operator code, inspect its revision, then provide the
reviewed pin explicitly:

```sh
npx urlcode extensions --project app
export PROJECT_SHA256=<the reviewed revision>
npx urlcode validate --local --host-file host.mjs --origin https://api.example.com
npx urlcode test --host-file host.mjs --origin https://api.example.com
npx urlcode audit --expect-routes 4 --host-file host.mjs --origin https://api.example.com
npx urlcode serve --host-file host.mjs --origin https://api.example.com
```

Do not calculate and approve a new pin automatically at server startup. Review
application modules as well as YAML. Trusted code can import other Node modules;
the extension revision is not an attestation of every transitive host import.

## Write the application behavior

`functions/me.mjs` reads `sessionUserId(request)`. On a session-protected route
it is the stable, opaque account id, not a password, session token, email or
role. Auth produces it only after its authorization and write-CSRF checks
succeed. The runtime strips client-supplied reserved headers before auth runs.
The accessor alone does not authenticate a `Request` created elsewhere.

`functions/echo.mjs` shows the complete handoff:

```js
import {sessionUserId} from '@jimhoyd/urlcode-auth';

export default async function echo(request, context) {
  const userId = sessionUserId(request);
  if (!userId) return Response.json({error: 'authentication_required'}, {status: 401});
  return Response.json({userId, label: context.inputs.path.label, received: await request.json()});
}
```

Replace the response with the unique business rule. Add a separate YAML route
for each endpoint, with its permitted methods, auth policy and input bounds.
URLCode validates the declared path input and JSON body before invoking the
function. Application membership, ownership, state transitions, persistence and
idempotency remain application responsibilities unless an installed extension
already owns them. Use the verified id; never take the acting user's id from a
body field. For trusted host lookups, pass a narrow callback over the public
operator service such as `getUser(id)`; do not maintain a second account index.

These functions use trusted Node execution and a package import. They do not
claim isolation, and the accessor does not reduce trusted code's ambient Node
authority. A `sandbox: true` function cannot import this package; the same
derived header can be read by pure project-local code as described in
[session identity](../../docs/EXTENSIONS.md#session-identity-in-functions).
Unsupported targets must refuse the declared capabilities.

## Exercise the native client flow

Send `Accept: application/json` and retain auth's cookies. Get a flow token from
`GET /account/csrf`, then register or log in through `/account/register` or
`/account/login` with the site `Origin` and `X-CSRF-Token`. Use the returned
session-bound `csrf` for later writes. Do not implement these endpoints in a
function. The [auth JSON contract](../../packages/auth/docs/JSON-API.md) owns
the request and response shapes.

`GET /api/me` returns `{userId}`; `POST /api/echo/example` with JSON returns
`{userId, label: "example", received: <body>}`. Signed-out callers get 401.
Missing or foreign write origin and missing or stale CSRF get 403. Auth owns
those denials; the functions do not run. Malformed JSON gets 400, an unsupported
body content type 415, and an oversized body 413. The runtime supplies no-store
for these protected routes.

The fixtures cover native login, distinct account identities, input handling,
header spoofing, CSRF/origin refusal and logout. Run them again after replacing
the examples, and add tests for the application's own rules. These checks are
not production deployment or security-assessment evidence.
