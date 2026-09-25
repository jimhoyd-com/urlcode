# URLCode auth

An optional, operator-installed authentication extension for URLCode. This repository contains the Node/SQLite implementation: password and passkey authentication, OpenID Connect, email codes, TOTP, recovery codes, versioned registration profiles, account lifecycle operations, administrative service operations and trusted HTML pages.

[![CI](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

The implementation is under active review. Local tests and builds are evidence of those checks, not an independent security assessment, production deployment, provider certification or recovery/soak result. See [SECURITY.md](SECURITY.md) for the trust boundary and [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) for what shipped; the original design spike is private maintainer material.

## Install

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with ui,auth --example
# or, in an existing site:
npx urlcode extensions add auth --example
```

Without `--example`, auth installs its capability only: the `/account/*`
pages (the default mount; move the route to change it), the operator service
with the minimal `{member, admin}` role model and `defaultRole: member` in
`operator-service.mjs` (edit it to change the roles), and private keys in
`data/`. No page of yours is protected until you add `auth: true` to a route.
`--example` also writes a `/private` page that only a signed-in caller can
read.

auth is released as a tarball on core's GitHub Release, at core's version, and
pinned by sha512 in core's `dist/addons.json`; only core is on npm.
`urlcode extensions add auth` adds `ui` too when the site lacks it, installs
both once at the top level of the site with `npm install --ignore-scripts`,
checks the pins and runs auth's scaffold. See
[add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts) for the
site layout and commands.

Stable publication does not establish production readiness: independent
security review, accessibility assessment, broader browser/device WebAuthn
coverage and deployment/soak/recovery exercises remain pending (see
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)). Prerelease versions may
change public exports, configuration keys and the SQLite schema without a
migration path; do not run the `alpha` channel on production accounts.

Use a current supported Node release with a patched SQLite build. The actual runtime requirement is a Node build whose bundled SQLite (`process.versions.sqlite`) is 3.51.3 or newer, or a patched 3.50.7+ / 3.44.6+ branch release; `engines.node` alone does not encode this, and the service (`src/auth-store.ts`) refuses other builds with `patched_sqlite_required` even when the package's minimum Node version is satisfied.

## Build from reviewed source

Operators who pin exact reviewed commits can build every package locally. This package depends on the shared `@jimhoyd/urlcode-ui` peer, which owns document layout, semantic fields, escaping, themes and the locale engine; authentication/administration behavior remains here. Core can use UI without auth/admin. Both peers are siblings in this repository, so CI builds them from the same commit.

One lockfile governs the workspace. From a clean checkout of the reviewed commit, install without lifecycle scripts, build core and every add-on, and pack them in dependency order. Nothing is published:

```sh
git checkout REVIEWED_40_CHARACTER_COMMIT_SHA
npm ci --ignore-scripts
npm run build && npm run build:addons
node scripts/pack-addons.ts /absolute/new-private-package-directory
```

Run `npm run verify` for each workspace package; packing runs the builds, not the HTTP suite. The tarballs are for local review; a site installs the release tarballs core pins.

## Extension definition

`@jimhoyd/urlcode-auth/extension` default-exports the auth extension definition (`defineExtension` from `@jimhoyd/urlcode/extensions`; it requires `ui`). Its `scaffold` returns the `extensions.auth` config, the `/account/*` and `/private` routes, the private `operator-service.mjs`, `data/encryption.key` and `data/csrf.key` files (mode 0600, fresh key material, an existing file kept) and one-line next steps; core writes them. Its `host` loads that operator service and CSRF key, receives the `ui` kit from `composeHost`, builds `authExtension`, and shares `{service, csrfKey}` with `admin`. It contributes its English catalogue and `auth/*` templates to `ui` through `contributes.ui`.

## Operator activation

Route YAML declares a versioned logical extension, not executable code:

```yaml
version: '1'
extensions:
  auth:
    version: '1'
    config:
      registration: 'off'
routes:
  /account/*:
    extension: auth
    methods: [GET, HEAD, POST]
  /private:
    respond: {text: Signed in}
    auth: true
```

The site's `host.mjs` activates it; operator settings such as senders and providers go in the `auth({...})` call:

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';
import { sendEmailCode } from './senders.mjs';

export default await composeHost(import.meta.url, [
  ui(),
  auth({ sendEmailCode }),
]);
```

`auth({...})` accepts the `authExtension` options except the kit and the revision pin, which come from the host. By default the service is the one `operator-service.mjs` default-exports and the CSRF key is `data/csrf.key`; pass `service` or `csrfKey` to supply your own (the host then leaves closing them to you). `composeHost` takes the reviewed revision from the operator policy passed with `--policy` beside `--host-file`, or from a static `PROJECT_SHA256` copied after review (`urlcode extensions add` prints it). Inspecting a revision with `inspectExtensionRevision(project)` grants nothing; never compute and automatically approve the current project during activation. Pass the canonical HTTPS origin (`AUTH_ORIGIN`) to `urlcode serve --origin`, with `--host-file host.mjs`. Guest/application code never chooses the module, database path, keys, sender credentials or grants.

Registration starts off. Bootstrap the first administrator from the site with `npx urlcode-auth bootstrap --operator-file "$PWD/operator-service.mjs"`, supplying `{email,password}` as bounded JSON on stdin. Never place passwords in command arguments or source files. The command returns account metadata, not the session token. A role/default-role configuration change is a reviewed operator change, not an administration-page edit.

## Project-level lifecycle hooks

A project can name its own function per lifecycle point in `extensions.auth.config.hooks`, using the same `{source, export}` shape (or a bare string, defaulting to the module's default export) `function`/`middleware` routes already use — the behavior-layer counterpart to `urlcode-ui`'s presentation layering (urlcode-auth#35, urlcode's docs/EXTENSIONS.md "Project-level lifecycle hooks"):

```yaml
extensions:
  auth:
    version: '1'
    config:
      registration: open
      hooks:
        beforeRegister: ./hooks/registration-rule.mjs   # bare string: default export
        onSignUp:
          source: ./hooks/on-signup.mjs
          export: provisionWorkspace
        onDelete: ./hooks/on-delete.mjs
```

Three lifecycle points are implemented:

- **`beforeRegister(input: {email, profile?})`** runs before an account is
  created, from the immediate `/register` endpoint and from the resumable
  `/signup/begin` step, and returns a typed verdict: `{allow: true}` lets the
  attempt continue, `{allow: false, reason}` rejects it and the `reason` is
  surfaced to the caller the same way any other registration rejection is (a
  `403` with that message). This is how "only `@acme.com` may register"
  becomes portable project code instead of a fork.
- **`onSignUp(input: {accountId, email})`** is a side-effect hook (no
  verdict) that fires once, after a *new* account is actually created — from
  the immediate `/register` endpoint and from `/signup/complete` (an
  existing-account signup attempt that resolves to sign-in, not a new
  account, never fires it). Use it for something like provisioning a
  workspace after sign-up.
- **`onDelete(input: {accountId, email})`** fires when the account owner
  schedules their own deletion through the account page's `/delete` endpoint
  (the deletion grace period still applies and can still be cancelled). It
  does not yet fire from an administrator-initiated deletion or from the
  background purge once the grace period elapses.

These hooks are first-party project code, the same trust category as any
`function`/`middleware` route: **trusted, in-process execution by default**,
following the runtime's trust model with no special case (urlcode's
docs/SPIKE-DEFAULT-TRUST-MODEL.md). A missing module, a module that fails to
import, or a named export that is not a function fails **activation** —
before this extension serves a single request — never the first request
that happens to reach the hook.

Each activation re-reads the hook's **entry** module from disk, so editing a
hook file and re-activating (a dev reload) takes effect without restarting
the process. Only the entry module is refreshed: modules the hook itself
imports stay on Node's module cache for the life of the process, so a change
to a hook's own dependency still needs a restart.

Core's extension-hook primitive loads these hooks and publishes their contracts
through `get_extensions`. Contract v1 is trusted-only: `sandbox: true` is
refused explicitly at activation. Declare a hook without `sandbox` (or with
`sandbox: false`) to use it.

## Authentication and presentation

`createAuthService` owns a private SQLite database outside the application directory. Its operations enforce authority, fresh authentication, delegation ceilings, replay protection and transaction boundaries. Callers must preserve the distinction between unrestricted operator APIs and actor-token administrative APIs. `authExtension` adds HTTP cookies, same-origin CSRF checks, bounded bodies and trusted pages.

Optional factories supply Google/Apple/generic OIDC and passkey providers. Unconfigured providers are not offered. Synthetic cryptographic fixtures do not prove real Google, Apple, authenticator or SES deployment behavior. The auth extension currently declares **Node only**; generic core extension support for AWS/Vercel does not make this SQLite service portable to their deployment environments.

### Passkeys and the relying-party domain

`createPasskeyProvider({origin, rpId, rpName})` (and `createAuthPreset`) binds passkeys to the canonical HTTPS origin with the canonical host as the WebAuthn relying-party ID; the provider refuses any other `rpId`. That is the default, and it is unchanged: ceremonies are accepted only from the canonical origin, so an operator [`--alias-origin`](../../docs/EXTENSIONS.md#site-origins-and-same-origin-checks) gets no passkeys.

To share passkeys across origins that sit under one registrable domain, the operator sets a [shared passkey relying-party domain](../../docs/EXTENSIONS.md#shared-passkey-relying-party-domain) beside the origins: `urlcode serve --origin https://app.site.example --alias-origin https://www.site.example --passkey-rp-id site.example`. Core validates it (a lowercase registrable domain equal to, or a parent of, every site origin's host; no IP address, single label or listed public suffix) and passes it to the activation as `passkeyRpId`. Auth then calls the provider's `withSite({rpId, origins})`: registration and authentication options carry the shared RP ID, and verification accepts a client origin that is any site origin (canonical or alias) and nothing else. A provider without `withSite` is refused at activation. It is never set in project YAML.

**Changing the RP ID makes existing passkeys stop working.** A credential is bound to the RP ID it was registered under: turning `--passkey-rp-id` on, changing it or turning it off strands every passkey registered under the previous RP ID, and those users must sign in with another method and register a new passkey (an account whose only sign-in method is a passkey needs [manual recovery](#operations-and-recovery)). Choose the RP ID before users enrol.

Auth records the RP ID each new passkey is registered under (issue #736): the ceremony's RP ID is stored with the credential (`rpId` in `StoredPasskey`/`AuthPasskey`, and an `rp_id` column that existing databases gain in place). At activation auth counts stored passkeys against the RP ID ceremonies now use (the operator `passkeyRpId`, otherwise the provider's canonical host) with one aggregate query, and prints a startup warning through core's [activation warnings](../../docs/EXTENSIONS.md#activation-warnings) when some cannot work:

- `N passkeys were registered under a different relying-party ID than the current one (<rp id>) and will not work until users re-register; ...` when recorded RP IDs differ;
- `N passkeys were stored before auth recorded relying-party IDs; if registered under the canonical host (<host>), as was the default, they will not work under the passkey RP ID <rp id> until users re-register; ...` only when a `--passkey-rp-id` other than the canonical host is set. Passkeys stored before this change have no record; auth assumes they were registered under the canonical host, the default until #729, which is wrong only if the operator already used `--passkey-rp-id` before upgrading (then the warning is spurious).

The warnings carry counts, the RP ID and the canonical host only, never an account, email or credential id, and appear in `validate`, `test` and `dev`/`serve` startup output as `{"event":"extension_warning","extension":"auth",...}`. They do not change verification: a mismatched passkey is still simply refused by the browser or the verifier, and the fix is still sign-in by another method and re-registration.

`createPresentation` supplies configured locale catalogues, plural rules, RTL, and validated theme variables/local logo paths. Messages are plain text and escaped by renderers. It does not load executable project templates or arbitrary HTML/CSS. Translation coverage and accessibility require review; the helper does not establish WCAG conformance. Registration metadata is descriptive data and never authorization authority. Private metadata is excluded from public projections; public and unsafe fields remain untrusted.

## Route requirements (`auth:`)

This package owns the vocabulary of a route's `auth:` short form (and of the
long form `policies.extensions.auth` it expands to). Core maps `auth: true` to
`{}` and an object to the same object minus `required`, and knows nothing else
about it; the keys and bounds are this package's `authPolicySchema`
(`src/auth.ts`), published as `policySchema` in the registration and in
`urlcode.json`. `urlcode validate`, `validateProject` and runtime startup check
routes against it and report a failure at the key the author wrote, for example
`Invalid extension policy at route /api/items, auth.bearer.quota.requests
(minimum): must be >= 1`. Adding or tightening a route key is a change here, not
in core's schema. See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md#protecting-a-route-the-auth-short-form).

## Bearer/API-key authentication

`AuthService` also owns an optional, separate credential kind for
machine/agent callers: bearer API keys, checked against the
`Authorization: Bearer <key>` header instead of the session cookie. A route
opts in with `auth: {bearer: {scopes: [...]}}` (see
[docs/EXTENSIONS.md](../../docs/EXTENSIONS.md#bearerapi-key-routes)), exclusive
of the session-based `role`/`permission`/`verified`/`freshWithinSeconds`/`onDeny`
keys.

An operator issues, lists and revokes keys outside route YAML — through the
same `AuthService` object that owns sessions, or the CLI:

```sh
echo '{"name":"ci-deploy-bot","scopes":["deploys.write"],"expiresInMs":7776000000}' \
  | urlcode-auth api-key-issue --operator-file /absolute/operator/auth.mjs
```

An optional `quota: {requests, window}` gives the key its own budget (see
[per-credential quota](#per-credential-quota)), and an optional `userId` makes
it act for a user (see [keys that act for a user](#keys-that-act-for-a-user)).

`issueApiKey` returns the raw key (`uak_<id>.<secret>`) exactly once; only its
scrypt hash (the same derivation `createAuthService` uses for passwords) is
stored, so it cannot be recovered afterward — treat it like any other secret.
`listApiKeys` never returns the raw key or its hash. `revokeApiKey` takes the
key's `id` (from `issueApiKey` or `listApiKeys`), not the secret.

The extension gate enforces expiry, revocation and the route's required
scopes with RFC 6750-shaped responses: a missing/malformed `Authorization`
header is a 401 with no error parameter; an unknown, wrong-secret, expired or
revoked key is a 401 with `WWW-Authenticate: Bearer error="invalid_token"`; a
valid key missing a required scope is a 403 with
`error="insufficient_scope"` naming the missing scopes. On success, the
verified key's id/name/scopes (never the raw key) are written into the
reserved `x-urlcode-context-auth-principal` request header as base64-encoded
JSON (`{id, name, scopes}`), so the protected route's own trusted
`function`/`middleware` can read who authenticated directly off its `Request`
object:

```js
const principal = JSON.parse(Buffer.from(request.headers.get('x-urlcode-context-auth-principal'), 'base64').toString());
```

This uses core's generic `x-urlcode-context-*` extension-context header
namespace (`@jimhoyd/urlcode/extensions`, `extensionContextHeaderPrefix`):
the runtime strips it from every inbound request before any extension or
guest code sees it, so a client can never inject or spoof a principal (see
[urlcode#618](https://github.com/jimhoyd-com/urlcode/issues/618) and
[extensions](../../docs/EXTENSIONS.md#handing-data-forward-into-a-protected-routes-own-context)).
The header is absent on a session-cookie-protected route (`auth: {role: ...}`
etc.) — only `bearer` writes it — so a route reading it must not assume it is
always present.

### The request principal

Separately from that header, auth is a principal provider for other extensions
on the same route (`providesPrincipal: true`; see
[request principal](../../docs/EXTENSIONS.md#request-principal)). On every
request its `authorize()` allows, it sets core's opaque request principal:

| Route protection | Principal id |
|---|---|
| session (`auth: true`, `role`, `permission`, ...) | the signed-in user's stable id (never the email), set after the CSRF check on a write |
| `bearer`, key issued with `userId` | that user's id |
| `bearer`, service key (no `userId`) | `apikey:<key id>` (`apiKeyPrincipalId(id)`) |

A service key belongs to no user, so it is its own principal, namespaced so it
can never equal a user id: records it creates in an
[owned store collection](../../docs/STORE.md#per-record-ownership) belong to
that key, and stop being reachable through the API once it is revoked or
expires; the operator can move them to another principal with
[`urlcode-store reassign`](../../docs/STORE.md#moving-records-to-another-principal).
A denied request never carries a principal. An impersonation session carries
the impersonated user's id, so an operator impersonating a user acts on that
user's owned records.

### Keys that act for a user

An operator can issue a key for an existing user
([urlcode#732](https://github.com/jimhoyd-com/urlcode/issues/732)): pass
`userId` (the id from `urlcode-auth users`) to `issueApiKey`, or in the
`api-key-issue` JSON:

```sh
echo '{"name":"alice-sync","scopes":["notes.read","notes.write"],"userId":"<user id>"}' \
  | urlcode-auth api-key-issue --operator-file /absolute/operator/auth.mjs
```

- **Principal.** The key sets the request principal to that user's id, so
  records it creates in an owned store collection belong to the user: they are
  the same records the user sees when signed in, and they survive rotating the
  key (issue a new key for the same user, then revoke the old one).
- **Authority.** The key still acts only within its own `scopes`, checked
  against the route's `auth.bearer.scopes`. The user's roles and permissions do
  not apply to it, and it never passes a session-protected route
  (`auth: true`, `role`, `permission`, ...), which still needs a session.
- **Validation.** `userId` must name an existing account whose status is
  `active`; an unknown id, a locked account or one pending deletion is refused
  with `invalid_api_key_user` and nothing is stored.
- **Disable and delete.** A user-linked key authenticates only while its user is
  `active`. Locking the account, or the account entering its deletion grace
  period, makes every key linked to it fail with the same 401 `invalid_token` a
  revoked key gets, from the next request; unlocking the account, or cancelling
  the deletion, makes them work again. When the account is purged its keys are
  revoked for good. `listApiKeys` and `api-key-list` report each key's `userId`
  (`null` for a service key) and `userDisabled` (`true` while the linked user is
  not active). Revoke a key explicitly when it must never return.
- **Handler context.** The `x-urlcode-context-auth-principal` header also
  carries `userId` for such a key (`{id, name, scopes, userId}`); it is absent
  for a service key.

Keys issued before this field existed, and keys issued without it, are service
keys (`userId: null`); an existing database gains the nullable `user_id` column
in place when the service opens it.

### Per-credential quota

A bearer route can also budget each API key separately
([urlcode#572](https://github.com/jimhoyd-com/urlcode/issues/572)):

```yaml
routes:
  /api/items:
    function: functions/items.mjs
    auth: {bearer: {scopes: [items.read], quota: {requests: 1000, window: 3600}}}
    policies:
      throttle: {quota: 60, window: 60}   # core, per client: still owns unauthenticated floods
```

`requests` (1 to 1,000,000) per `window` seconds (1 to 2,592,000, 30 days) use
the units of core's `policies.throttle` `quota`/`window`.

A key can also carry its own budget, set when it is issued
([urlcode#703](https://github.com/jimhoyd-com/urlcode/issues/703)): pass
`quota: {requests, window}` (same bounds) to `issueApiKey`, or in the
`api-key-issue` JSON on stdin:

```sh
echo '{"name":"plan-gold","scopes":["items.read"],"quota":{"requests":50000,"window":3600}}' \
  | urlcode-auth api-key-issue --operator-file /absolute/operator/auth.mjs
```

**A key's own quota replaces the route's.** A key issued with one is counted
only against it, on every bearer route it authenticates on, whether or not the
route declares a `quota`; the route's `auth.bearer.quota` applies to keys issued
without one. This is how plan tiers work: one route, different keys, different
budgets. The quota is fixed at issuance (issue a new key and revoke the old one
to change it); `listApiKeys` and `api-key-list` report it, and keys issued before
this field existed have none (`quota: null`). Core `policies.throttle` is
separate: it still applies to every request, per client, before auth runs.

The gate counts a request only after the key has authenticated and covers the
route's scopes, so 401 and 403 keep their meaning. An allowed request's
response reports the budget it was counted against, in the same fields the
refusal uses: `RateLimit-Policy: "credential";q=<requests>;w=<window>` and
`RateLimit: "credential";r=<remaining>;t=<seconds>` (added by the extension's
`middleware()` hook after the route's handler has answered). These values are
per credential, so they must never reach a shared cache: core already sends
`Cache-Control: no-store` on every response of a route auth protects, and
refuses to start with a `cache` strategy other than `no-store` on such a route.
The request that would exceed the budget is refused with a 429 before the
route's handler runs:

- body `{"error":"credential_quota_exceeded"}`, `Cache-Control: no-store`;
- `Retry-After: <seconds>` until the window closes;
- the IETF RateLimit fields core throttle uses, under the policy name
  `credential`: `RateLimit-Policy: "credential";q=<requests>;w=<window>` and
  `RateLimit: "credential";r=0;t=<seconds>`.

Semantics, matching the sign-in attempt counter:

- **Fixed window per credential.** The window opens at the key's first counted
  request; a refused request is not counted, so a retry loop cannot keep its
  own window open. Routes that restate the same `requests`/`window` share one
  counter per key; a route with a different budget gets its own. A key's own
  quota is one counter for that key across every route.
- **Counted by key id, never the secret.** The counter row is a SHA-256 of the
  key's public id and the budget, in the same `auth_attempts` table (100,000-row
  ceiling, expired rows swept on write and by `urlcode-auth cleanup`).
- **Durable on one host.** The count lives in the auth SQLite database, so it
  survives a restart, and every process on the host that opens the same
  database file shares it. It is not shared across hosts.
- **Fails closed.** When the store is unavailable, or the counter table is at
  capacity, the request fails with a 503 (as the key lookup itself does); it is
  never waved through uncounted.

On a route that also declares core `throttle`, both budgets share the same
structured-field lists. On an allowed response the list is
`"credential", "default"`:

```http
HTTP/1.1 200 OK
Cache-Control: no-store
RateLimit-Policy: "credential";q=2;w=60, "default";q=60;w=60
RateLimit: "credential";r=1;t=60, "default";r=59;t=60
```

The 429 keeps the credential's policy: core's response phase appends its own
`default` member to the same lists, so the refusal carries both budgets and
`Retry-After` stays the credential's:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 45
RateLimit-Policy: "credential";q=2;w=60, "default";q=60;w=60
RateLimit: "credential";r=0;t=45, "default";r=57;t=31
```

`r=0` on the `credential` member names the exhausted budget.

Core throttle is the other half: it counts per client (address) before auth
runs, so it answers floods of unauthenticated or invalid-key requests without
spending an scrypt verification on each. Declare both on a public bearer API.

## Optional breached-password screening

An operator can configure `checkPassword: createPasswordBreachChecker()` on `createAuthService`. This optional Have I Been Pwned range check sends only the SHA-1 prefix, requests padded responses, bounds concurrency/deadline/response bytes, and fails closed when the check cannot complete. It does not send the password or full hash to the service. Configuring the callback introduces an external service dependency; do not enable it silently or describe it as a complete hardened preset. Offline fixtures are not evidence of live service availability.

## Email and local development

SES is optional so an auth installation that uses another delivery adapter does
not install the AWS SDK and its provider chain. Install it explicitly before
using the built-in sender:

```sh
npm install --save-exact @aws-sdk/client-sesv2@3.1135.0
```

`createSesSender({region, from, origin, authMount, credentials?})` then returns a
callable token sender with `sendEmailCode`, `notify` and `close`. Without the
optional SDK it fails immediately with an installation instruction. Wire
callbacks explicitly into the auth/admin factories. Production credentials
come from operator configuration or the SDK credential chain; never put them
in YAML. Delivery is bounded and cancellable; services cannot guarantee that
an email reaches an inbox. A test-only `transport` injection does not load the
SDK.

`createDevelopmentSender` requires `allowDevelopment: true` and either a private output directory outside the project plus its `projectRoot`, or `allowConsoleTokens: true`. File notices use exclusive `0600` files and a bounded count. Console mode deliberately exposes development tokens and must never feed shared production logs. Sender helpers do not infer safety from `NODE_ENV`.

## Operations and recovery

Run `urlcode-auth --help` for the current CLI. Operator commands have full database authority; stdin avoids putting secrets in process arguments. User/audit listings currently return a bounded page; use service pagination for complete exports. Doctor's successful local database check is not live-provider verification.

| Command | Arguments | Purpose |
| --- | --- | --- |
| `bootstrap` | `--operator-file`, JSON `{email,password}` on stdin | Create the first administrator; returns account metadata, not a session token |
| `users` | `--operator-file` | List accounts (bounded page of 100) |
| `sessions` | `--operator-file`, JSON `{accountId}` on stdin | List an account's sessions |
| `revoke` | `--operator-file`, JSON `{accountId}` on stdin | Revoke all sessions of an account |
| `audit` | `--operator-file` | List audit events (bounded page of 100) |
| `import` | `--operator-file`, JSON `{users:[{email,passwordHash,emailVerified?}]}` on stdin | Import generic password hashes; only those fields are accepted |
| `rotate-key` | `--operator-file` | Re-encrypt records with the active encryption key; reports changed/remaining |
| `purge` | `--operator-file` | Permanently remove accounts whose deletion grace has elapsed |
| `cleanup` | `--operator-file` | Sweep expired sessions/tokens (bounded batch) |
| `configuration` | `--operator-file` | Print configuration revision, registration mode, security policy and roles |
| `doctor` | `--operator-file` | Local database/configuration readiness check |
| `api-key-issue` | `--operator-file`, JSON `{name,scopes,expiresInMs?,quota?,userId?}` on stdin | Issue a bearer/API key, optionally acting for an active user; returns the raw key once, never stored |
| `api-key-list` | `--operator-file` | List issued keys (id/name/scopes/created/expires/revoked/lastUsed/quota/userId/userDisabled; never the raw key or its hash) |
| `api-key-revoke` | `--operator-file`, JSON `{id}` on stdin | Revoke a key by its id |
| `validate` | `--operator-file` | Offline validation of the loaded service's configuration |
| `auth-baseline` | none (refuses `--operator-file`) | Offline synthetic checks against a temporary runtime |
| `verify-deployment` | JSON `{origin,authMount,allowDevelopment?,allowTurnstile?}` on stdin | Anonymous header/cookie checks of a deployed site |
| `backup` | JSON `{database,destination,projectRoot}` on stdin | Online SQLite backup to a new private path |
| `restore` | JSON `{backup,destination,projectRoot}` on stdin | Restore a backup to a new private path |

`--operator-file` is an absolute path to a module that default-exports an `AuthService`.

Backup/restore accepts JSON paths on stdin. `createBackup({database,destination,projectRoot})` uses SQLite's online backup API, including committed WAL pages, with a bounded worker and integrity checks. `restoreBackup({backup,destination,projectRoot})` restores to a **new** path. Both require private operator paths outside the project and refuse overwrite. Never copy only a live `.sqlite` file and assume its WAL is included. See [backup and restore platform guarantees](../../docs/AUTH-BACKUP.md), including Windows ACL and directory durability limits.

Back up encryption keys, CSRF keys and reviewed static configuration separately. Database snapshots contain sensitive account/audit data and password hashes, but do not export key files. Restoring historical data also restores historical sessions/tokens and revocation state: plan revocation and recovery before reopening traffic. Rotate keys by adding a new active key, retaining decryption keys while bounded migration reports remaining records, then remove old keys only after completion and backup verification. Old writers fail closed after activation switches. Keep a tested isolated restore procedure.

`composeHost`'s `close` releases the service and CSRF key auth opened itself, after all extension runtimes stop; a service, key or sender the operator passed in stays the operator's to close. Scheduled purge/sweep operation and backups are operator responsibilities; opportunistic cleanup is not a retention policy.

Apache-2.0. auth is released as a tarball on core's GitHub Release; only core is
published to npm.

## Operator presets and enrollment

`createAuthPreset({preset: 'standard', origin, rpName, sender?})` supplies passkeys, standard session limits and seven-day deletion grace. Without a sender it returns an explicit notice that email flows are unavailable. TOTP and recovery are service capabilities; remembered devices can optionally exempt ordinary MFA, but never grant fresh step-up authority.

`createAuthPreset({preset: 'hardened', origin, rpName, sender, checkPassword: createPasswordBreachChecker()})` requires both adapters and supplies mandatory email verification followed by TOTP enrollment, shorter sessions and 30-day deletion grace. Spread `preset.service` into `createAuthService` in `operator-service.mjs` and `preset.extension` into `auth({...})` in `host.mjs`. Choosing the online breach checker makes password creation/reset depend on that external service; inject an approved local checker if needed. Deliberate overrides change the effective policy and should be reviewed.

Restricted enrollment sessions can verify their email and enroll TOTP, but cannot authorize protected application routes or administration. Required verification revokes old sessions and requires a fresh sign-in before factor enrollment. Public routes without auth policies remain public. These controls do not establish independent security certification or live provider readiness.

Configuration is database-pinned. Before changing modes, roles or security requirements, run `urlcode-auth configuration --operator-file /absolute/operator-service.mjs` and retain its revision. Review the new operator configuration and pass `approveConfigurationChangeFrom: 'the-old-64-character-revision'` on the first `createAuthService` startup. The generated operator file accepts that explicit approval through `AUTH_CONFIG_FROM`. A matching already-applied migration can be repeated safely; an unrelated pin fails.

Migration preserves accounts, enrolled credentials and history, while revoking sessions and pending authentication/registration state, closing pending cases and recording an audit entry. Existing roles must remain valid and active administration cannot be removed accidentally. Valid pending-deletion cancellation links retain only their original expiry. Old workers reject reads and writes after migration; restart every instance with the reviewed configuration, remove the approval variable, and separately review/pin the changed route project. Schedule the transition as a maintenance operation; do not edit database metadata manually.

`englishCatalogue` (also exported as `authCatalogue`) exports the semantic UI keys for catalogue authors. Translations are plain text and escaped at rendering; runtime templates never execute project markup. No complete non-English language pack is bundled. Dates, provider identifiers and user data retain their own values.

## Presentation

Auth is one part of the product, while this package retains ownership of
identity, sessions, CSRF, validation and recovery behavior. Its extension
registration publishes a machine-readable `authoring` contract through
`urlcode extensions --host-file ... --json` and MCP `get_extensions`. Follow
those configuration, copy, template and lifecycle-hook surfaces before copying
an auth screen or flow into the project. The contract also lists focused checks
for the edit loop; full project tests remain the handoff evidence.

Every account screen is an `auth/*` template in the urlcode-ui kit language with a declared view model (`authTemplates`, each with a sample view; `authUiTemplates` is the block the `ui` extension takes). The extension computes the view and the template only places it: a template cannot change which steps a flow has, what a form validates, what is escaped, or the CSRF field and headers a page sends. Forms, fields and buttons arrive in the view as renderer-produced markup built by the kit's shared form primitives (`field`, `postForm` and friends from `@jimhoyd/urlcode-ui`).

`authExtension` requires `ui`: the kit is the only render path. auth's definition requires `ui`, so `composeHost` activates `ui` first and hands auth its kit, and auth contributes `authCatalogue` and `authUiTemplates` to `ui` through `contributes.ui`. Declare `ui` before `auth` in `urlcode.yaml` too: the runtime activates extensions in the order `urlcode.yaml` declares them, and auth refuses activation when `ui` is missing or not yet activated. Auth reads `ui.kit` per request and never captures it at activation. `@jimhoyd/urlcode-ui` is an optional exact peer that `urlcode extensions add auth` installs once at the top level of the site.

```yaml
extensions:
  ui: { version: "1", config: { theme: { name: Acme }, templates: ui/templates } }
  auth: { version: "1", config: { registration: "off" } }
routes:
  /assets/ui/*: { extension: ui, methods: [GET, HEAD] }
  /account/*: { extension: auth, methods: [GET, HEAD, POST] }
```

Screens render through `ui.kit.page`: the project's theme, layout, hashed stylesheet and copy apply, a project file `ui/templates/auth/<screen>.html` shadows the shipped template, and `urlcode-ui doctor --extensions @jimhoyd/urlcode-auth` reports every `auth/*` template behind its view model (the CLI loads the namespace, copy and samples from this package's `authUiTemplates` export; without the flag it sees the kit alone). Copy then resolves through the kit's presentation, which carries the kit catalogue, the auth catalogue and the project's `extensions.ui` copy; omit `presentation` in that case. If both are given, `presentation` wins and must register the kit catalogue for the layout's own keys.

There is no fallback render path: earlier releases rendered the same templates through the shared primitives when `ui` was absent, and that branch has been removed. The auth passkey script and the optional challenge widget are nonce-bound to the kit's page nonce and the page CSP admits only that nonce (plus the challenge origin when configured).

Changing `configurationTag` deliberately advances the approved configuration revision for provider/callback/profile-policy deployments that cannot be fingerprinted as simple data. The service does not automatically fingerprint executable callbacks. Session idle and absolute limits do participate in the declared configuration fingerprint.

### Verification-first signup

The browser registration entry point resumes a short-lived, browser-bound signup
wizard. With `requireEmailVerification`, it verifies an emailed numeric code before
accepting a password or passkey; `sendSignupCode` must be configured. Credentials,
profile and required consent are finalized together. Open/invited signup creates
one account/session transaction; waitlist signup creates only a pending application
until an administrator approves it. Passkey applications retain their credential
and account binding through approval. Existing accounts are never overwritten:
the identifier step gives the same next page and sends a registration-attempt
notice privately. The low-level operator registration/bootstrap methods remain
explicit privileged provisioning APIs, not public HTTP signup shortcuts.

### Unverified accounts and first mailbox proof

Without `requireEmailVerification` (the `standard` preset's default), anyone can
register an address they do not control and then add sign-in methods to that
unverified account. So the first time an unverified account proves control of its
mailbox, the proof claims the account: in the same transaction the service removes
every passkey, linked provider identity, authenticator, passkey second factor,
recovery code, remembered device, pending email change or factor recovery, other
outstanding email token and session established before it, marks the email
verified, and records an `account.claimed` audit event listing what was removed.
What happens to the password depends on the proof:

| First mailbox proof | Password | Session |
| --- | --- | --- |
| Password reset link | Replaced by the one the prover chooses | None; sign in again |
| Email sign-in code | Removed; set one later through password reset | The one the code issues |
| Verification link, submitted in a browser holding a live session of that same account | Kept, with every other method: the verifier is the registrant | Unchanged unless verification is required |
| Verification link, any other browser | Removed; `POST /verify` answers `passwordResetRequired: true` and the page links to password reset | None |

Earlier factors are neither demanded nor accepted by a claiming email code,
because the claim removes them. An account that is already verified is never
claimed: reset still keeps its passkeys, linked identities and factors, and an
email code still requires its second factor. Accounts created from a provider
identity whose email the provider asserts as verified start verified. An
administrator's `verify-email` action is an attestation, not a mailbox proof, and
does not claim; review an account's sign-in methods before verifying it by hand.

With `requireEmailVerification`, an unverified session cannot add passkeys,
provider links, authenticators or remembered devices in the first place, and
public signup verifies the mailbox before any credential is stored.

### Lost second-factor recovery

`allowEmailFactorRecovery: true` explicitly enables an email fallback for verified
accounts that lost their second factor. It is disabled by default because control
of the mailbox becomes a recovery authority. Configure `sendFactorRecovery`; the
bundled SES/development senders and presets provide it. The flow confirms a private
email link in the originating browser, starts a 24-hour waiting period and provides
a separate cancellation link. GET requests never consume either capability.

Completion checks the account version, revokes sessions and pending authority,
removes the old TOTP/recovery codes, and issues an enrollment-only session. Only that
recovery session can enroll the replacement factor; ordinary password/provider
logins cannot race it, even when the site's global MFA requirement is off. No
application authority returns until the replacement factor is confirmed. Recovery
state expires, is rate-limited, survives restart and is revoked by configuration
migration. This is email-based factor recovery, not proof of a person's legal
identity or the later public lost-everything workflow.

### Anonymous deployment checks

Run `urlcode-auth verify-deployment` with bounded JSON on stdin containing the
canonical HTTPS `origin` and `authMount`. It performs two anonymous GET requests,
checks the expected login/unauthenticated account status, restrictive CSP,
no-store, path-private referrer and nosniff headers, and secure host-only cookies. It does not send
credentials, follow redirects, read response bodies, send email or create accounts.
A failed check exits nonzero and prints only named booleans, never response bodies
or network errors. `allowDevelopment: true` permits HTTP only for loopback hosts.
These checks cover the observed public responses; they do not establish live
provider readiness, security assessment, recovery or load-test results.

### Passkey second factors and remembered devices

Set `allowPasskeySecondFactor: true` to let a user explicitly enroll an owned,
user-verified passkey as a second factor at `/account/second-factors`. A passkey
used for primary sign-in cannot also satisfy the second factor in that sign-in.
WebAuthn challenges bind to the browser; opaque factor proofs are consumed with
the primary credential, account version and counter in the final transaction.
TOTP/recovery-code alternatives remain available. Restricted enrollment may add a
factor through a narrowly scoped path, including the recovery-session grant.

Set `trustedDeviceTtlMs` (at most 30 days; default disabled) to offer
`/account/trusted-devices`. Remembering a device requires recent actual MFA and an
explicit user action. It creates a separate Secure, HttpOnly, host-only cookie;
ordinary device recognition is never an MFA exemption. Remembered sign-in has no
fresh authentication timestamp and cannot satisfy admin/credential step-up or mint
another exemption. Users can revoke individual remembered devices; account
security/version changes invalidate them. These options are part of the pinned
operator configuration and require the explicit migration workflow when changed.

`blockDisposableEmails: true` optionally refuses new registrations using the
bundled disposable-domain snapshot, including subdomains. The dataset revision is
part of the configuration fingerprint. Existing-account login/recovery is not
blocked by this policy. Exact operator allow/block lists still apply. The snapshot
is fallible and may reject legitimate addresses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance and CC0 data terms.

### Offline operational checks

`urlcode-auth validate --operator-file /absolute/operator/auth.mjs` checks the loaded service's configuration revision, registration mode, bounded role definitions and public security policy. Output contains policy values and aggregate counts, not accounts, credentials, database paths or callback configuration. It requests no migration or account mutation. Loading an operator module executes trusted initialization: use an existing configuration without migration approval, and review that module's own startup behavior. This command does not sandbox operator code or verify providers.

`urlcode-auth auth-baseline` requires no operator module and refuses one. It creates private temporary fixtures and an auth database outside the fixture project, runs a bounded child process, then removes them. Seventeen named checks (listed in `test/auth-baseline.test.ts`) exercise the real local runtime without opening a listener: anonymous authorization denial, CSRF and origin enforcement, Secure/HttpOnly/Strict host cookies, no-store auth responses, credential withholding from guest Request and derived header context, revocation, and restricted enrollment authority. Extra failure-only markers are recorded when a probe, deadline or cleanup fails. A failed check or deadline produces a nonzero exit status and redacted results. The command uses no customer state, network, mail or live providers. These synthetic checks are limited regression evidence, not an independent security assessment, deployment certification, browser test, load test or recovery drill.

`verify-deployment` remains a separate network check. Its stdin option `allowTurnstile: true` permits only the reviewed `challenges.cloudflare.com` challenge origin in script/frame/connect CSP checks; the default remains strict about external origins. Neither command proves a deployment's provider credentials, delivery, breach callback or complete abuse policy.

### Localized email and abuse controls

Pass `emailCopy: createEmailCopy({catalogues: {...}})` to a sender helper to customize bounded plain-text subjects and bodies. Catalogue entries must preserve every link/code placeholder. Account notices use the saved locale; anonymous flows use request language without revealing whether an account exists. Delivery failures for post-commit security notices do not roll back account changes; operators must monitor their sender.

`AuthOptions.abuse` enables durable progressive password backoff and trusted-client/signup-domain velocity budgets. Configure the runtime trusted-proxy boundary before enabling client limits. Every per-client auth budget (the per-client password-attempt budget and the `client`/`signupClient` limits) keys an IPv4 address, including an IPv4-mapped IPv6 address, by the address itself and an IPv6 address by its /64 network, so rotating addresses inside one allocation earns no fresh budget; callers behind one IPv6 /64 share a budget. The /64 grouping is fixed and matches core's [throttle client identity](../../docs/policies/operations.md#client-identity-and---trusted-proxies). Optional `createTurnstileChallenge` supplies a fixed-origin widget and bounded server verification; challenge success never overrides a hard budget. Provider callbacks and existing token redemption keep their own bound proofs.

Auth pages use `Referrer-Policy: strict-origin`: path/query credentials are never sent as referrers, while browsers retain the Origin header needed for no-JavaScript POST forms. A state-changing request must carry an `Origin` that is one of the site's origins: the canonical `--origin`, or an operator [`--alias-origin`](../../docs/EXTENSIONS.md#site-origins-and-same-origin-checks) (matched by core's `isSiteOrigin`; `AuthHttp` takes the list as its `origins` option). Missing, null or foreign Origin headers remain rejected. CSRF tokens and email links stay bound to the canonical origin. Passkey ceremonies work only on the canonical origin unless the operator sets a [shared passkey RP ID](#passkeys-and-the-relying-party-domain). Live pagination cursors use a process-local HMAC key; restart the search after a worker restart or changed boundary.
