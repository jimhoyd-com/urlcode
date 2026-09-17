# Spike: an authentication and authorization plugin (`urlcode-auth`)

Status: proposal, nothing implemented. This spike answers what an auth
package built on URLCode's principles would look like: everything a project
declares lives in portable YAML, every secret and provider stays with the
operator, application code stays untrusted, and every deployment target
either enforces the declaration or refuses it at activation with the route
named. It covers accounts, roles and permissions, username/password, Google,
Apple, passkeys, phone/SMS, email, recovery (including forgot password), an
accounts page, and the groundwork for organizations, teams and SSO.

The comparison with Google, Uber, Airbnb and the open-source auth projects
(section 4) is what fills the gap list beyond the requested feature set.
The pages are Tailwind CSS with shadcn/ui markup, sign-in is identifier
first (two pages) and registration is its own multi-step flow (section 5).
Every method and channel is a switch, and a project gets working sign-in
with passwords and passkeys before any external service exists (section 11).

## 1. Principles carried over

- **Behavior in YAML, infrastructure outside it.** `auth.yaml` declares
  methods, policies, roles and pages. Twilio credentials, SES regions, Google
  client secrets and Apple signing keys are operator material bound in host
  code or an operator file outside the checkout, the same way function
  bindings are granted today ([function security](FUNCTION-SECURITY.md)). If
  someone else takes the YAML it works with their own senders and providers.
- **Standards first.** Every flow maps to a published standard (section 6),
  so the YAML names known behavior rather than this package's opinion.
- **The plugin seam, not a fork of the runtime.** The package is a host
  plugin on the existing hook seam ([plugins](PLUGINS.md)): it sees each
  matched request before the handler and each response before it is written.
  `urlcode.yaml` names the extension document (`auth.yaml`), never the
  package; the operator passes the plugin to `startServer` or an adapter,
  and activation refuses a declared extension no plugin claims. Section 7
  lists the four small core seams the plugin needs that do not exist yet.
- **Untrusted application code.** Guest functions never see credentials,
  password hashes, session secrets or provider tokens. They get a narrow,
  grantable binding that answers "who is this and what may they do".
- **One store, every target.** Accounts, sessions and credentials live in
  the project's primary store, the one the [link store](DYNAMIC-LINKS.md)
  already is, with its export and restore discipline, through one interface
  with a backend per target (section 8). The same `auth.yaml` deploys to
  the self-hosted server, Vercel, AWS Lambda and Cloudflare (section 9).
- **Off unless declared.** No method, page or channel exists until
  `auth.yaml` declares it. A project with an empty `methods` block has no
  way to sign in and says so at activation.

## 2. How a project adds it

The package lives in its own repository and is published separately, with a
peer range on the runtime it was tested against. A project adds it the way
it adds anything else:

```sh
npm create urlcode my-site && cd my-site      # a fresh project from the starter
npm install @jimhoyd/urlcode-auth              # the dependency, from its own repo
npx urlcode-auth init                          # adds the auth routes and config
npm run dev                                    # sign-in works: passwords and passkeys
```

`init` does three things and prints each:

1. Writes `auth.yaml` beside `urlcode.yaml`. It is an ordinary included
   document: `version`, the auth routes, and an `extensions.auth` block
   with `preset: standard`, every optional method present but commented out
   next to the environment variables it needs.
2. Adds `auth.yaml` to `includes` in `urlcode.yaml`, and a `robots`
   disallow for the mount when a `site` block exists. This is what adds the
   auth routes: they are routes like any other, so they appear in
   `urlcode routes`, the audit, the route diff and every target's
   inventory, and a project can rename or drop any of them.
3. Wires the plugin into the starter's server file with the file senders
   bound for development, and lists what to set before production.

What `auth.yaml` looks like after `init`, trimmed:

```yaml
version: "1"
extensions:
  auth:                             # validated by the plugin's schema, section 3
    preset: standard
    session: { cookie: __Host-session, idle: 30d }
    methods: { password: {}, passkey: { rpName: My Site } }
routes:
  /account/*: { extension: auth }   # pages, JSON API, provider callbacks
```

And how the project's own routes use it, in `urlcode.yaml`:

```yaml
routes:
  /admin/*:
    page: { file: admin.html }
    policies: { auth: { role: admin, onDeny: sign-in } }
  /api/posts:
    function: { file: posts.js }
    policies: { auth: { permission: content.write, tokens: [session, bearer] } }
```

`auth` is a policy like `throttle` or `cache`: it goes in `policies`, it can
live in a `profile`, it shows in the audit table and the route diff, and a
target that cannot enforce it refuses the route at activation. The `protect`
list in `extensions.auth` remains for path patterns across many routes; a
route's own `policies.auth` wins.

The division of what goes where:

| | `urlcode.yaml` | `auth.yaml` (included) | server file (operator) |
|---|---|---|---|
| Names the include | `includes: [auth.yaml]` | | passes the plugin |
| Auth routes | | `/account/*: { extension: auth }` | |
| Which routes need what | `policies.auth` per route or profile | `protect` patterns | |
| Methods, sessions, roles, recovery, limits, pages, theme | | `extensions.auth` | |
| Secrets, senders, providers' credentials, store connection | | never | all of it |
| Portable when copied to another host | yes | yes | no, by design |

No guest middleware is installed. The runtime's route-local middleware runs
inside the WASM guest and cannot hold a session key or reach a store, so
auth lives in the host as a plugin, which is the runtime's host-side
middleware seam. The one install step outside YAML is the plugin line in
the server file, and `init` writes it. It cannot be YAML by principle:
YAML names files and behavior, never code to load.

## 3. Shape of the package

```
@jimhoyd/urlcode-auth
  auth.yaml              declared by the project (portable)
  senders / providers    bound by the operator (not portable, not in YAML)
  store                  collections in the project's primary store, no store of its own
  pages                  server-rendered account pages, overridable per file
  api                    JSON endpoints under the same mount for SPA integrators
  cli                    urlcode-auth users|roles|sessions|export|import
```

Operator wiring, the only non-YAML part (what `init` writes into the starter):

```js
import { startServer } from '@jimhoyd/urlcode';
import { urlcodeAuth } from '@jimhoyd/urlcode-auth';
import { twilioSms, sesEmail } from '@jimhoyd/urlcode-auth/senders';

await startServer({
  project: './site',
  plugins: [urlcodeAuth({
    config: './site/auth.yaml',
    store: sqlite('./var/store.sqlite'),  // the project store, links and auth together; postgres(...) in production
    secrets: process.env,                 // AUTH_SESSION_KEY, GOOGLE_CLIENT_SECRET, …
    senders: { sms: twilioSms(process.env), email: sesEmail(process.env) },
  })],
});
```

`auth.yaml`, all keys optional except `version`, `methods` and `session`:

```yaml
version: "1"
preset: standard                    # minimal | standard | hardened, fills what is not set (section 11)
mount: /account                     # where pages and the JSON API live
origin: https://example.com         # RP ID and redirect base; --origin overrides
session:
  cookie: __Host-session            # __Host- prefix, Secure, HttpOnly, SameSite=Lax
  idle: 30d                         # sliding expiry
  absolute: 90d                     # hard cap, NIST 800-63B AAL1 style
  rememberDevice: 30d               # skip second factor on a trusted device
methods:
  password:
    minLength: 12                   # NIST: length, no composition rules
    breached: k-anonymity           # HIBP range check, off | k-anonymity
    hash: scrypt                    # scrypt (built in) | argon2id (optional dep)
  passkey:
    rpName: Example
    residentKey: preferred          # discoverable credentials for usernameless
    userVerification: preferred
    attestation: none
  google: { scopes: [openid, email, profile] }
  apple:  { scopes: [name, email] }
  emailCode: { digits: 6, ttl: 10m }       # one-time code by email (also "magic link")
  smsCode:   { digits: 6, ttl: 5m, regions: [US, CA, GB] }
  totp: { issuer: Example }                # authenticator apps, RFC 6238
verification:
  email: required                   # required | optional | off
  phone: optional
secondFactor:
  policy: optional                  # off | optional | required | required-for: [role]
  methods: [passkey, totp, smsCode, emailCode]
  recoveryCodes: 10
recovery:
  forgotPassword: { channels: [email], ttl: 30m }
  lostSecondFactor: { channels: [recoveryCode, email, smsCode], cooldown: 24h }
  accountRecovery: { channels: [email, smsCode], review: manual }   # for "lost everything"
limits:                              # per account and per client, both required
  signIn: { attempts: 10, window: 15m, lockout: 15m }
  codes:  { attempts: 5, window: 15m, sends: 5, sendWindow: 1h }
  signUp: { perClient: 20, window: 1h }
roles:
  viewer: [content.read]
  editor: [content.read, content.write]
  admin:  ["*"]
defaultRole: viewer
protect:                             # route patterns → what a request must hold
  - paths: [/admin/*]
    require: { role: admin }
    onDeny: sign-in                  # sign-in | 403 | 404
  - paths: [/api/*]
    require: { permission: content.read }
    tokens: [session, bearer]        # accept a session cookie or an API token
    onDeny: 401
  - paths: [/drafts/:id]
    require: { permission: content.write }
notifications:
  newDevice: [email]                 # "new sign-in" notice
  passwordChanged: [email]
  emailChanged: [email]              # sent to both the old and new address
identifier: [email]                  # email by default; add phone or username to accept them too
registration: open                   # open | invite-only | off
signIn: identifier-first             # identifier-first (two pages) | single-page
profile: { name: required }          # extra registration fields, all optional by default
terms: { version: "2026-09", url: /terms }
theme:                               # shadcn/ui CSS variables, no CSS build needed
  primary: "222.2 47.4% 11.2%"
  radius: 0.5rem
pages:                               # optional overrides of the shipped pages
  signIn: auth/sign-in.html
  layout: auth/layout.html
organizations:                       # section 10: reserved and validated, inactive
  enabled: false
```

Everything above is checked against a JSON schema on load (unknown keys
rejected, the same discipline as `urlcode.yaml`), and `urlcode-auth validate`
runs it without starting a server.

## 4. What Google, Uber, Airbnb and the open-source projects do

The requested list (password, Google, Apple, passkey, phone/SMS, email,
recovery, organizations, accounts page) is the surface a user sees. The
following is what the products people trust do underneath, and what the
open-source projects have converged on. Items marked **added** were not in the
request and are in scope for the first releases (sequence in section 15);
phone-first sign-in is the one item deliberately left out: phone stays an
optional identifier behind email.

### Consumer products

| Practice | Google | Uber | Airbnb | Added to proposal |
|---|---|---|---|---|
| Passkeys as the default sign-in, password as fallback | yes | yes (2024) | yes | `passkey` first in `methods`; usernameless via discoverable credentials |
| Phone number as a primary identifier | secondary | **primary** | primary or email | not adopted: email first; `identifier: [email, phone]` accepts phone as a second identifier |
| One-time code by SMS or email instead of a password | yes | yes | yes | `emailCode`, `smsCode` methods |
| Second step (2SV) with authenticator, SMS, prompt, security key | yes | yes | yes | `secondFactor` block, TOTP, passkey, codes |
| Risk-based step-up (new device, new country, sensitive action) | yes | yes | yes | **added**: `stepUp` for sensitive actions, `newDevice` signal; full risk engine out of scope |
| "New sign-in on device X" notification | yes | yes | yes | `notifications.newDevice` |
| Trusted devices ("don't ask again on this device") | yes | yes | yes | `session.rememberDevice` |
| Device and session list with remote sign-out | yes | yes | yes | accounts page: sessions tab, revoke one or all |
| Recovery phone and recovery email, separate from sign-in identifiers | yes | yes | yes | **added**: recovery contacts distinct from identifiers |
| Recovery codes for lost second factor | yes | no | no | `secondFactor.recoveryCodes` |
| Cooling-off period after recovery contact changes | yes (7 days) | yes | yes | **added**: `recovery.cooldown`, changes to recovery contacts take effect after a delay, notice to the old contact |
| Re-authenticate before sensitive changes (password, email, delete) | yes | yes | yes | **added**: `stepUp.actions: [changePassword, changeEmail, deleteAccount, addPasskey]` |
| Account enumeration resistance on sign-up, sign-in, forgot password | yes | yes | yes | identical responses and timing; codes sent whether or not the account exists |
| Password breach check, no composition rules, paste allowed | yes | n/a | yes | `password.breached`, NIST 800-63B rules |
| Account linking (same email via Google and password) | explicit | explicit | explicit | **added**: link only after a verified email match and an explicit confirmation, never automatic |
| Sign in with Apple private relay emails | yes | yes | yes | Apple relay address stored as-is; email change flow handles relay |
| Account deletion with a grace period and export | yes (Takeout) | yes | yes | **added**: `deletion: { grace: 30d }` and per-account export of personal data |
| Consent and terms acceptance recorded with version | yes | yes | yes | **added**: `terms: { version, url }`, acceptance stored with timestamp |
| Rate limiting per account and per client, CAPTCHA on pressure | yes | yes | yes | `limits`, plus **added**: `challenge` hook so an operator can plug a CAPTCHA or Turnstile without the package choosing one |

### Open-source projects

Keycloak, Ory Kratos, Authentik, Authelia, Zitadel, Supabase Auth (GoTrue),
SuperTokens, Logto, Auth.js, Lucia and Better Auth were compared. What they
agree on, and what this proposal adopts:

- **Sessions are opaque server-side records, not JWTs, for browsers.**
  Kratos, Lucia, Better Auth and Supabase's newer guidance all keep the
  browser on an opaque cookie and issue tokens only for APIs. Adopted:
  cookie sessions by default, bearer tokens as a separate, revocable
  credential.
- **Self-service flows are state machines with a flow id**, not a pile of
  endpoints (Kratos "flows", Keycloak "authentication flows", Logto
  "interaction"). Adopted: each flow (sign-in, sign-up, recovery,
  verification, settings) is a resumable record with a short TTL, so a
  multi-step sign-in with a second factor survives a page reload.
- **Identity schema separate from credentials.** Kratos and Zitadel model
  identifiers (email, phone, username), traits and credentials separately,
  which is what makes "phone-first" and "several emails" possible. Adopted in
  the data model (section 8).
- **Hooks and webhooks on lifecycle events** (Better Auth hooks, Supabase
  auth hooks, Kratos "after" hooks, Keycloak event listeners). Adopted as
  observability events on the runtime's event seam plus operator callbacks
  (`onSignUp`, `onSignIn`, `onRecovery`), never as YAML-named code.
- **Admin impersonation and audit log** (Keycloak, Authentik, Better Auth
  admin plugin). Adopted with a mandatory audit row and a visible banner;
  impersonation is off by default.
- **Invitations and API keys** (Better Auth organization and API key plugins,
  Logto, Zitadel service users). Adopted: invitation tokens for the
  organization groundwork, API keys as hashed bearer credentials with scopes.
- **Magic links versus codes.** Supabase and Auth.js default to magic links;
  Kratos and Logto favor codes because links break in mail scanners and
  cross-device flows. Adopted: codes by default, links as an option on the
  same `emailCode` method.
- **Multiple sessions per account, listable and revocable** (all of them).
  Adopted.
- **Pluggable password hashing with upgrade on sign-in** (Keycloak, Kratos).
  Adopted: the hash row records its algorithm and parameters, and a
  successful sign-in re-hashes when the declared algorithm changed.
- **SCIM and SAML arrive with organizations** (Keycloak, Zitadel, Authentik,
  WorkOS-style products). Reserved, section 10.

What none of them do that this proposal keeps: the YAML is the whole
declaration and it is checked by the same audit, compliance and route-diff
tooling as the rest of a URLCode project, so an auth change shows up in the
project's pull request check like any other route change.

## 5. Flows

Each flow is a resumable record (`flow_id`, kind, state, expires) so a page
reload or a second device does not lose progress. All pages and JSON
endpoints live under `mount`.

**Registration.** One flow, one page per step, each step a resumable state
of the same flow record:

1. `mount/register`: identifier (email, phone or username per
   `identifier`), plus the provider buttons and a "create a passkey" option
   when those methods are declared. Submitting an identifier that already
   exists shows the same next page; the existing account gets a "someone
   tried to register with your email" notice instead of a new account.
2. `mount/register/verify`: the code sent to the identifier when
   `verification` is `required` for its kind (`optional` moves this step to
   the accounts page, `off` skips it). Verifying first, before any
   credential is stored, keeps unverified accounts out of the store.
3. `mount/register/credential`: password (length and breach check, paste
   allowed, a strength meter without composition rules), or passkey creation,
   or nothing when the identifier itself is the credential (`emailCode`,
   `smsCode`) or a provider supplied it.
4. `mount/register/profile`: only when the project declares profile fields
   (`profile: { name: required, … }`) or `terms`; otherwise skipped.
5. Session created, `defaultRole` assigned, `auth.signUp` emitted, optional
   redirect to the `returnTo` the flow was started with (same-origin only).

Registration by provider (Google, Apple) enters at step 1, returns from the
callback with a verified email and lands at step 4 or the session. A project
that wants closed registration sets `registration: invite-only`, which keeps
the pages but requires an invitation token in the flow.

**Sign-in, identifier first.** Two pages, the pattern Google, Apple,
Microsoft and Uber use, because it lets the second page show only the
methods that account has and lets a passkey or a provider skip the password
entirely:

1. `mount/sign-in`: the identifier field, a usernameless passkey button
   (conditional UI autofill when the browser supports it), and the provider
   buttons.
2. `mount/sign-in/password` (or `/passkey`, `/code`): the page for the
   method chosen, with the identifier shown read-only and a "not you?" link
   back. When the account has several first factors, this page offers them
   as a list ("use your passkey instead", "email me a code"). An unknown
   identifier still gets a second page: it shows the password field and
   fails with the same generic error and the same timing as a wrong
   password, so the two-page flow does not become an account oracle.
   Sending a code to an unknown identifier is a no-op that looks like a
   send.
3. Second factor when the policy or the account requires it, skipped on a
   trusted device.
4. Session. `signIn: identifier-first` is the default; `signIn: single-page`
   puts identifier and password on one page for projects that prefer it.

Provider sign-in (Google, Apple) goes through the authorization code flow
with PKCE, `state` and `nonce`; the callback is the only route that accepts
the provider redirect. Unknown-provider-identity plus a verified matching
email offers linking after re-authentication, never silently.

**Forgot password.** Identifier → the account's recovery channel receives a
short-lived code or link (`recovery.forgotPassword`) → code proves possession
→ new password (breach-checked) → every other session is revoked → a
"password changed" notice goes to the account. The response to the first
step is the same for known and unknown identifiers. The code is single-use,
hashed at rest and bound to the flow, and a wrong code counts against
`limits.codes`. If the account has a second factor, the second factor is
still required after the reset (a reset must not become a bypass).

**Lost second factor.** Recovery code, or a code to a recovery contact after
`recovery.lostSecondFactor.cooldown` with a notice to every contact; the
cooldown is the window in which the legitimate owner can cancel.

**Lost everything.** `recovery.accountRecovery` with `review: manual` opens a
case record for an operator with the recovery contacts and last-known device
facts; the package never auto-approves it. This is what Google's and Airbnb's
"verify your identity" queues are; the package supplies the case, not the
judgment.

**Settings.** Change password, add or remove passkeys, add or remove
providers, change email or phone (verify the new one, notify the old one,
recovery cooldown applies), manage recovery contacts, sessions list, download
personal data, delete account (grace period). Every sensitive action requires
a fresh authentication within `stepUp.maxAge` (default 10 minutes).

**Verification.** Email and phone verification are their own flows so a
sign-up can complete without them when `verification` allows it, and the
accounts page nags until done.

## 6. Standards each part maps to

| Part | Standard |
|---|---|
| Password rules, hashing, recovery, session lifetimes | NIST SP 800-63B (memorized secrets, AAL levels), OWASP Password Storage and Authentication cheat sheets; scrypt (RFC 7914) built into Node, Argon2id (RFC 9106) optional |
| Passkeys | W3C WebAuthn Level 3, FIDO2 CTAP2, discoverable credentials, `Sec-Fetch-Site` and origin checks |
| Google | OpenID Connect Core 1.0 on OAuth 2.1 (draft) with PKCE (RFC 7636), `state`, `nonce`, discovery (RFC 8414 / OIDC Discovery), ID token validation (RFC 7519, JWK RFC 7517) |
| Apple | Sign in with Apple: OIDC with `response_mode=form_post`, client secret as an ES256 JWT, private email relay |
| TOTP | RFC 6238 on HOTP RFC 4226, 30-second step, one-step drift, replay protection |
| One-time codes by SMS and email | NIST 800-63B out-of-band authenticators (restricted for SMS: the YAML must opt in), single use, short TTL, hashed at rest |
| Sessions and cookies | RFC 6265bis cookie prefixes (`__Host-`), SameSite, OWASP Session Management cheat sheet; Fetch Metadata for CSRF on state-changing requests plus a same-origin check |
| Bearer tokens and API keys | RFC 6750 `Authorization: Bearer`, hashed at rest, revocable (RFC 7009 semantics), introspection-style `describe` (RFC 7662 shape) for operators |
| RBAC | NIST RBAC model (roles → permissions, users → roles), with resource-scoped grants for the organization groundwork |
| Rate limiting responses | RFC 6585 `429` with the IETF RateLimit header fields the throttle policy already emits |
| Security headers on auth pages | The runtime's `security` policy `hardened` profile; auth pages additionally send `Cache-Control: no-store` and disable compression (BREACH) |
| Email and SMS sending | Senders implement one interface; SES and Twilio are the first two. Message templates are per project, sending credentials are per operator |
| Organizations and SSO (later) | SAML 2.0 SP profile, OIDC RP for enterprise IdPs, SCIM 2.0 (RFC 7643, RFC 7644) provisioning, `.well-known` discovery |
| Personal data export and deletion | GDPR Articles 15, 17 and 20 as the shape: machine-readable export, deletion with a grace period, audit trail |

## 7. Core seams the plugin needs

The plugin contract today lets a plugin answer or observe a request. Four
additions to the runtime, none auth-specific, would let auth work without
forking it. Any future extension (payments, comments, search) would use the
same four.

1. **`extension` route handler and `extensions` block.** A route may
   declare `{ extension: <name> }` as its handler, beside `redirect`,
   `respond`, `page`, `static`, `download`, `link` and `function`. A
   document may carry a top-level `extensions: { <name>: {...} }` block,
   merged across includes with one owner per name. At activation the
   runtime hands each block and each such route to the plugin that
   registered `extensions: ['auth']`, validated against the schema the
   plugin supplies, and refuses activation when a route or block names an
   extension no plugin claims. The runtime never interprets the block.
2. **Plugin-registered policy modules.** The policy registry is fixed to
   five names today. A plugin may register one module under its extension
   name (`auth`), with the same `PolicyModule` shape, `targets` table,
   `describe()` for the audit and phase placement (request phase after
   `throttle`, before `cache`). This is what makes `policies.auth` on a
   route work with profiles, the audit and the route diff for free.
3. **A request context bag and a grantable binding.**
   `PolicyRequest.context` that the `auth` policy fills with a frozen
   `{ principal, roles, permissions, session }` summary, and an `auth`
   guest binding granted through the existing operator grant file so an
   approved function can call `auth.principal()` and `auth.can(permission,
   resource)`. It holds no credentials and cannot sign anyone in.
4. **A store binding for plugins**, section 8: the plugin gets collections
   in the project's primary store rather than opening its own.

Interoperability with the five policies, in pipeline order: `agents` may
block bots from auth pages (fine); `throttle` runs before auth so the package
adds per-account limits on top of the per-client ones rather than replacing
them; `cache` runs after auth and must never store an authenticated
response, so `auth` marks its responses `no-store`, adds `Vary: Cookie` on
protected routes, and the cache policy learns to bypass on the session
cookie name as it does on `Authorization`; `security` headers apply
unchanged; `compression` is disabled on auth pages by the response hook.

## 8. One store: auth data lives in the project's primary store

The runtime already has a durable store: the link store, a worker-isolated
SQLite database with named collections, optimistic versions, an atomic
audit table, and consistent export and restore. Auth must not bring a
second one. The proposal is to promote that store to the project store and
let extensions use it through a binding.

**What the store gains** (generic, used by links unchanged):

- `store.collection(name)` for plugins, namespaced by extension
  (`auth.accounts`, `auth.sessions`, …), with the existing get, list,
  create, update, delete and version semantics.
- Declared **unique keys and secondary indexes** per collection, registered
  at activation (`identifiers` unique on `kind + value`, `sessions` indexed
  by `account_id`), so lookups are not scans and uniqueness is enforced
  where the data is.
- **Expiry**: a record may carry `expires`, and the store sweeps expired
  rows on a timer (flows, codes, sessions). Links already have `expires`
  semantics at read time; this adds the sweep.
- **Transactions** across a few operations in one collection (create a
  session and touch the account in one step).
- The audit table records extension operations with the same shape, and
  export and restore cover every collection, so one `urlcode links export`
  style command backs up links and accounts together, and the recovery
  drill in [operations](OPERATIONS.md) applies to both.

**One interface, several backends.** The store interface is what the plugin
and the link handler program against. Backends:

| backend | where | notes |
|---|---|---|
| SQLite (`node:sqlite`, worker-isolated) | `node`, local testing, single host | the default today; in-memory for tests |
| Postgres | `node`, `vercel`, `aws` | one table per collection or one jsonb table with indexes; the second backend to write |
| Cloudflare D1 (SQLite) with Durable Objects for the write serialization the worker gives today | `cloudflare` | same SQL dialect as the default backend, so migrations are shared |

The backend is chosen by the operator (`store: sqlite('./var/store.sqlite')`
or `store: postgres(process.env.DATABASE_URL)` in the server file, a D1
binding on Cloudflare), never in YAML. Local testing uses SQLite or memory;
production uses whatever the operator connects; the YAML and the data model
are the same in both. Migrations are versioned per collection owner and run
at activation, refusing to start on a newer schema than the code knows.

The auth data model on that store, one collection each:

```
auth.accounts          id, status (active|locked|pending-deletion), created, deleted_at, terms_version, org_id (null until section 10)
auth.identifiers       account_id, kind (email|phone|username), value (normalized), verified_at, primary     unique(kind, value)
auth.credentials       account_id, kind (password|passkey|totp|provider|api-key|recovery-code), data, created, last_used, name   index(account_id)
auth.sessions          id (hashed), account_id, created, last_seen, expires, absolute_expires, device, trusted_until, revoked_at   index(account_id), expires
auth.flows             id, kind, state, account_id?, expires
auth.codes             flow_id, channel, hash, expires, attempts, sent_to
auth.recovery_contacts account_id, kind, value, verified_at, effective_at (cooldown)
auth.roles             name, permissions, org_id?
auth.assignments       account_id, role, org_id?, resource?   index(account_id)
auth.cases             id, account_id, kind, opened, state, notes
```

The store's own audit table records every auth mutation with the actor and
request id, so the auth audit log is the store's audit log filtered by
collection, not a separate table.

Normalization: emails lower-cased and Unicode-normalized with the local part
kept as-is except for case; phone numbers stored in E.164 after validation
against the declared `regions`. Every secret-bearing field holds a hash;
export writes rows with hashes intact so a restore is exact, and
`--redact` strips them for support cases.

## 9. Every target works, including Cloudflare

Auth on the self-hosted server only would make it a second-class feature.
The requirement is that a project with `auth.yaml` deploys to `node`,
`vercel`, `aws` and `cloudflare` with the same YAML. What that takes:

- **A Node-free core.** The auth logic (flows, sessions, RBAC, passkey and
  OIDC verification, TOTP, code handling, page rendering) is written the
  way the `agents` and `security` policies already are: no `node:` imports,
  WebCrypto only, checked by the same closure test that guards the Worker
  today. Node-only pieces (the SQLite backend, the file sender, the CLI)
  live in separate entries.
- **One portable password hash.** `scrypt` exists in Node but not in
  WebCrypto, and a hash written on one target must verify on another when
  a project moves. The default is therefore **Argon2id in WASM** (RFC 9106,
  the OWASP first choice), which runs identically on every target and fits
  the runtime's existing WASM discipline. PBKDF2-HMAC-SHA256 (in WebCrypto
  everywhere) is the fallback option. Each hash records its algorithm and
  parameters, and a target that cannot verify a recorded algorithm refuses
  activation naming it, rather than locking users out at sign-in.
- **The store binding per target**, section 8: SQLite on `node`, Postgres
  or another external backend on `vercel` and `aws`, D1 plus a Durable
  Object on `cloudflare`. Sessions, flows and codes are ordinary records,
  so nothing depends on process memory; the per-account limits use the
  store the same way the throttle policy's route-partitioned mode does.
- **Cloudflare build.** `urlcode build --target cloudflare` compiles routes
  today and carries no plugins. It gains an operator-side option,
  `--extension auth=@jimhoyd/urlcode-auth/worker`, in the build command
  rather than in YAML, so the Worker bundle includes the auth core and the
  compiled `extensions.auth` block, and the D1 and secret bindings come
  from `wrangler.toml` as any Worker's do. Routes with `extension: auth` or
  `policies.auth` are refused at build time when the option is missing,
  with the route named, exactly as unsupported policies are today.
- **Vercel and AWS** take the plugin through the existing handler options
  and an external store backend; the SQLite backend is refused there with
  the reason (no durable filesystem).
- **Senders and providers** are HTTPS APIs (SES SigV4, Twilio, Google,
  Apple) and work from every target with `fetch`; the SES and Twilio
  senders are written against `fetch` and WebCrypto, not the AWS SDK.
- **`verify-deployment`** exercises the mount on the deployed target, so
  the proof that auth works on Cloudflare is the same command as for any
  route.

Trade-offs to state plainly: Argon2id in WASM costs a few tens of
milliseconds per hash on a Worker and counts against CPU limits, so the
parameters are tuned per target and recorded; passkey ceremonies and OIDC
callbacks fit comfortably. Durable Objects add a Cloudflare-specific
serialization layer that the other backends get from their database. None
of this changes the YAML.

## 10. Organizations, teams and SSO: what to prepare now

Not built in the first releases, but the schema and YAML reserve the shape so
adding it is additive:

- `org_id` on accounts, roles and assignments is nullable from day one; a
  personal account is an account with no organization.
- Permissions are already resource-scopable (`assignments.resource`), which
  is what "editor on team X" needs.
- The `organizations` YAML key exists and is validated, with `enabled: false`
  refusing the rest of its keys until the feature ships.
- Identifier uniqueness is global, not per organization, which matches
  Google Workspace and Slack: an email belongs to one account that can be a
  member of several organizations.
- Reserved routes under `mount/org/*` and a `.well-known` path for SSO
  discovery are excluded from the plugin route table now so a project cannot
  claim them by accident.
- Later: invitations, teams as nested roles, domain verification for
  automatic membership, SAML and OIDC identity providers per organization,
  SCIM provisioning, and audit export per organization.

## 11. Turning services on, and getting started in minutes

Setting up SES, Twilio, Google and Apple takes days of console work, DNS and
review queues. Nothing in the package may depend on them being ready.

**Every method and channel is a switch.** A method exists only when
`methods` declares it, a channel only when the operator binds a sender for
it. The two are checked against each other at activation and the result is
printed, never silently degraded:

```
auth: methods password, passkey, totp active
auth: emailCode declared but no email sender bound: method disabled
auth: verification.email is "required" but no email sender bound: refusing to start
      (set verification.email: off, or bind a sender)
auth: google declared but GOOGLE_CLIENT_ID unset: provider button hidden
```

The rule: a missing sender disables what needs it and says so; a
declaration that cannot be honored without it (required verification,
a recovery channel that is the only one, `secondFactor.policy: required`
with only SMS) refuses activation with the fix named. `urlcode-auth
validate --senders email,sms` runs the same check without a server, so CI
sees it before a deploy does.

**What works with no external service at all**: password, passkeys, TOTP,
recovery codes, trusted devices, step-up re-authentication, sessions and
device lists, roles and permissions, API keys, the audit log, the accounts
page, personal-data export and deletion with a grace period. Those are the
core of the first release and none of them sends a message anywhere.

**Development senders.** `senders: { email: fileSender('./var/outbox'),
sms: fileSender('./var/outbox') }` writes each message as a file and logs
its path; `consoleSender()` prints it. The starter binds these, so
verification, codes and forgot password are exercisable on a laptop with
nothing configured. They refuse to activate when `NODE_ENV` is `production`
unless `allowInProduction: true` is set, so a file sender cannot ship by
accident.

**Presets.** `preset` fills every key a project has not set, like the
`hardened` policy profile does for policies:

| preset | what it turns on | needs |
|---|---|---|
| `minimal` | password, sessions, accounts page, per-account limits | nothing |
| `standard` (default) | `minimal` + passkeys, TOTP, recovery codes, trusted devices, step-up, email verification `optional`, forgot password by email | an email sender for the email parts; without one they disable with a notice |
| `hardened` | `standard` + verification `required`, second factor `required`, breach check on, `__Host-` cookie, shorter sessions, new-device notices, deletion grace 30d | an email sender, refused otherwise |

**Quick start.** `urlcode-auth init` in a project writes `auth.yaml` with
`preset: standard` and every optional method present but commented out with
the environment variables it needs beside it, adds the `robots` disallow for
the mount, wires the file senders in the starter's server file, and prints
the three commands to run. Time to a working sign-in with passwords and
passkeys on a fresh project is the time to run `npm install`. Adding Google
later is uncommenting two lines and setting two variables; SES and Twilio
are swapping the sender import.

**Provider readiness is reported, not assumed.** `urlcode-auth doctor`
calls each bound sender's and provider's dry-run (SES `GetAccount`, Twilio
account fetch, Google and Apple discovery documents) and prints what would
fail at first use, so an operator finds out before a user does.

## 12. Accounts page

The accounts page is the part a person sees most, so it has to cover every
common task without the project writing any of it. This section lists the
whole surface, what to keep from PeerEyes, how the open-source projects
handle the same page, and how a project overloads it.

### 12.1 The full surface

One mount (`/account` by default), one left navigation on wide screens and
a tab strip on phones, each section a server-rendered page with the JSON
API behind it. Every section is on unless the method or feature it needs is
off, in which case the section hides rather than showing a dead control.

| Section | What a person can do | Needs |
|---|---|---|
| **Overview** | See who they are signed in as, the identifier in use, recent security events (last five audit rows), pending tasks ("verify your email", "add a second factor", "confirm your recovery contact") | nothing |
| **Profile** | Edit the declared profile fields (`profile:` in YAML), display name, avatar upload when declared, language | nothing |
| **Sign-in methods** | See every way they can sign in, masked (`j***@example.com`, `+1 ••• 4321`, "Passkey on MacBook, added 2 May"); add a passkey (named, with the device's own name suggested); link Google or Apple; add or change email or phone (verify the new one, notice to the old one); remove a method. The last remaining method cannot be removed, and removing the only verified recovery-capable method is refused with the reason | one method each |
| **Password** | Set a password when the account has none, change it (current password or a fresh step-up required), see when it was last changed, breach warning if the check finds it; a reset here signs out every other session | `password` |
| **Two-step verification** | Turn on TOTP (QR plus manual key, confirm with a code), register a security key or passkey as a second factor, choose the preferred method, view and regenerate recovery codes (shown once, download or print), see which codes are used; disable with step-up | `secondFactor` |
| **Devices and sessions** | A list of active sessions: device family, approximate location from the client address when the operator enables it, first and last seen, "this device", trusted-device status; sign out one, sign out all others, forget a trusted device | nothing |
| **Recovery** | Set and verify a recovery email and a recovery phone that are separate from sign-in identifiers; changes take effect after the cooldown with a notice to the previous contact and a cancel link; see the open recovery case if one exists | `recovery` |
| **Connected apps and API keys** | Create a personal API key (named, scoped to permissions the account holds, shown once, hashed at rest), see last use, revoke; see and revoke third-party grants once organizations and SSO exist | `apiKeys` |
| **Notifications** | Choose channels per notice type where the project allows a choice (new device: email and SMS; marketing never appears here because the package sends none) and the consent record with a stop link that needs no sign-in | a sender |
| **Privacy and data** | Download a JSON export of everything stored about the account (identifiers, methods without secrets, sessions, audit rows, profile), see the terms version accepted and when, re-accept when the project publishes a new version | nothing |
| **Delete account** | Type the display name or identifier to confirm, step-up, then a grace period (`deletion.grace`) during which signing in cancels the deletion; after it, hard delete and a scrub of audit rows to the retention the project declares | nothing |
| **Organizations** (later) | Memberships, roles per organization, invitations received, leave; for org admins a members list, invitations sent, roles, domain verification, SSO connection, SCIM token | `organizations` |

Plus the flows that are not sections but pages under the same mount:
sign-in and sign-in method, registration steps, verification, forgot
password and reset, second-factor prompt, step-up prompt, the provider
callback, the "stop" page for notices, and the error page. Every page has
the same layout, the account menu (avatar, name, sign out) on the right,
and a "back to site" link the project can point anywhere.

Cross-cutting rules the whole surface follows:

- **Masked identifiers everywhere.** A page never prints a full email or
  phone the person did not just type, so a shoulder-surfer or a shared
  screen leaks little.
- **Step-up before anything sensitive.** Password change, method removal,
  recovery contact change, API key creation, second-factor disable, export
  and deletion all require a fresh authentication within `stepUp.maxAge`,
  and the prompt says which action asked for it.
- **Destructive actions need typing.** Delete account and "sign out
  everywhere" ask the person to type a word; nothing destructive is one
  click.
- **Everything is a notice.** Each change on the page sends the declared
  notice to the account's contacts, including the one being removed, with
  a "this wasn't me" link that opens a recovery case and revokes sessions.
- **Copy is a catalogue.** Every string on every page lives in one
  catalogue keyed by id, with English shipped and other languages added by
  the project (PeerEyes's `t()` pattern), so translation and rewording
  never touch a template.
- **No script required** except passkeys and the OTP digit boxes, which
  degrade to a single input.

### 12.2 What to keep from PeerEyes

PeerEyes is a custom, library-free implementation of phone OTP, passkeys,
Google and Apple over a Postgres data model, with a single "Your Windows"
screen carrying its account features. The parts worth carrying over
unchanged:

- **Contact points separate from identities**, with a partial unique index
  on the verified value. This is the recovery-contact model the spike
  wants, already proven.
- **Discoverable-credential passkey sign-in with no identifier step**, so
  passkey login has no enumeration oracle at all. It is the first-page
  passkey button in section 5.
- **Refusing to remove the last method** and the sole recovery-capable
  method, with a reason. Kept as the sign-in methods rule above.
- **Single-use `state` and `nonce` with a stored flow row** for providers,
  and never matching a provider identity by email. Kept as the linking
  rule.
- **Masked labels** (`auth/mask.ts`) for every identifier on screen.
- **Tokens shown once, hashed at rest, last-use recorded** (keep tokens).
  Kept as the API-key model.
- **A per-recipient consent record with a stop link that needs no
  sign-in**, and a terms version stored with it. Kept in Notifications and
  Privacy.
- **Sessions with `auth_method` and `assurance`** columns, which is what
  makes step-up and "trusted device" decidable from the session row.
- **An audit event catalogue** (`auth.login`, `auth.identity_linked`,
  `account.exported`, …) with client address and user agent and never a
  credential. Kept as the shape of the store's audit rows.
- **Trusted-proxy-aware client address** and fixed-window limits keyed by
  identifier and by client, both. The runtime already has the first; the
  second is `limits`.
- **A log channel for local development** instead of a real sender, and
  Twilio Verify (a hosted OTP service) rather than raw SMS for codes, which
  avoids storing SMS code hashes at all. The spike adopts Verify as one
  `smsCode` backend beside raw Twilio Messaging.
- **Type-the-name confirmation and a JSON export endpoint** for the
  destructive and data sections.

What PeerEyes leaves out that the spike adds, because a general package
cannot skip them: a sessions and devices list with sign-out everywhere,
account-security notices (new device, method changed), a second recovery
contact rather than a single non-removable phone, lockout and progressive
backoff beyond fixed windows, passwords and their reset flow, a second
factor, and any theming or template override.

### 12.3 How the open-source projects handle the account page

| Project | Account UI | Overridable how | Notes |
|---|---|---|---|
| Keycloak | Account Console (React, keycloak.v3 theme): personal info, sign-in methods, device activity, linked accounts, applications, groups, resources | Theme directories override FreeMarker templates and the console's CSS and messages per realm | The most complete surface; heavy, its own server |
| Ory Kratos | No UI; self-service "settings flow" JSON that a UI renders; Ory Elements provides React and preact components | Bring your own UI, or use Elements and theme it | Flow model is the one the spike adopts; UI is the project's problem |
| Authentik | User portal: settings, MFA devices, sessions, connected sources, tokens | Brand settings and custom CSS, flows editable in the admin | Django, strong on flows, UI not embeddable |
| Zitadel | Console for users: profile, passwordless, MFA, external IdPs, sessions | Branding per organization; login v2 is a Next.js app you can fork | Enterprise oriented |
| Logto | Prebuilt sign-in experience plus an Account API; account center pages are recent | Branding, custom CSS, custom pages via the API | Closest to "hosted pages you restyle" |
| SuperTokens | Prebuilt React UI for sign-in and MFA; no full account page | Override components or bring your own | Account settings are left to the app |
| Supabase Auth, Better Auth, Lucia, Auth.js | No account UI at all; APIs, hooks and examples | Your own components | The common default: the app builds the page |
| Clerk (commercial, for reference) | `<UserProfile/>` component: profile, email and phone, connected accounts, passkeys, MFA, active devices, delete account | Appearance prop, CSS variables, element overrides | What people mean by "an accounts page that just works" |

Where this spike lands: the surface of Keycloak's console and Clerk's
`UserProfile`, delivered as server-rendered pages a project restyles the
way Logto and Keycloak allow, without a separate server and without a
client framework. Nobody in the open-source column ships that combination
with a YAML declaration behind it.

### 12.4 Overloading: the project stays clean

The runtime itself never depends on `urlcode-auth`; the person's project
does. The project holds `urlcode.yaml`, `auth.yaml` and whatever it chooses
to override; everything else comes from the package and updates with it.
The override order, most specific wins:

1. Package defaults, then `preset`.
2. The project's `extensions.auth` block in `auth.yaml`.
3. A route's own `policies.auth` and `profile`.
4. `theme`: the shadcn/ui CSS variables, logo, favicon, product name, the
   "back to site" link. Most projects stop here.
5. `copy`: a catalogue file with only the ids the project wants reworded or
   translated; unlisted ids fall back to the shipped English.
6. `pages`: one template file per named page or partial (`layout`,
   `nav`, `signIn`, `sessions`, …). A project overrides the layout to wrap
   the pages in its own chrome and leaves the rest, or replaces one page
   entirely. Templates receive a documented view model and use no logic
   beyond slots and loops, so the package can change internals without
   breaking overrides; the package version records which view-model
   version each template was written for and warns at activation when it
   is behind.
7. `assets`: an extra stylesheet appended after the shipped one, for
   projects that want their own Tailwind build.
8. Host code, for operators only: senders, providers, store, and the
   `challenge` and lifecycle hooks.

`urlcode-auth eject <page>` copies a shipped template into the project as
a starting point, and `urlcode-auth doctor` lists every override in effect
and any template written against an older view model.

### 12.5 Stack

Server-rendered HTML, one page per flow step, styled with Tailwind CSS and
the shadcn/ui component vocabulary. How that fits a runtime that ships no
client framework and allows no runtime build:

- **Markup** is the shadcn/ui component markup (Card, Form, Input, Button,
  Alert, InputOTP, Separator, Avatar, Tabs, DropdownMenu for the account
  menu) written as static HTML templates. shadcn components are copied
  source, not a dependency, so their structure and class names are usable
  without React. Interactive pieces (the OTP input's per-digit boxes, the
  passkey button's `navigator.credentials` call, the tabs on the settings
  page) are a few hundred bytes of plain script each, served with a CSP
  nonce; every page still works without script except passkeys, which the
  page says.
- **CSS** is compiled once at package publish time with the Tailwind CLI
  against the shipped templates, purged, and served as one static file
  under `mount/assets/auth.css` with a content hash and
  `immutable` caching. No CDN, no runtime Tailwind, no unpurged stylesheet.
- **Theming** uses the shadcn/ui CSS variables (`--background`,
  `--primary`, `--radius`, …) so a project's `theme` block or an overridden
  `layout` sets brand colors and radius without rebuilding CSS. Dark mode
  follows `prefers-color-scheme` and a `class` toggle, as shadcn does.
- **Overrides**: `pages` in YAML replaces any template with a project file.
  A replaced template can keep using the shipped CSS (the class set is
  documented) or bring its own stylesheet; the package never compiles a
  project's CSS. Projects that use React and want the real shadcn
  components get `@jimhoyd/urlcode-auth/react`: the same flows as typed
  components against the JSON API, for single-page apps.

Templates: `layout`, `register`, `registerVerify`, `registerCredential`,
`registerProfile`, `signIn`, `signInMethod`, `secondFactor`, `verify`,
`recover`, `recoverReset`, `settings`, `security`, `sessions`, `data`,
`error`. Every page sends `Cache-Control: no-store`, the project's security
headers, and a per-flow CSRF token in addition to the same-origin check. The
JSON API under `mount/api/*` mirrors each step for single-page apps and
mobile clients, with the same flow ids.

## 13. Operations

- `urlcode-auth validate`, `users list|lock|unlock|delete`, `roles`,
  `sessions revoke --account`, `export`, `import`, `cases list|resolve`.
- Observability events on the runtime seam: `auth.signIn`, `auth.signUp`,
  `auth.factor`, `auth.recovery`, `auth.lockout`, `auth.session.revoke`,
  `auth.case.open`, each with outcome and method, never with identifiers in
  the clear. Metrics: sign-ins by method and outcome, lockouts, code sends
  by channel, open cases.
- Compliance rules (`auth-baseline` profile) for the existing
  `--compliance` run: session cookie prefix and flags, `no-store` on auth
  responses, enumeration-safe responses, second-factor policy declared,
  breach check on, SMS opted in explicitly.
- `verify-deployment` gains checks for the mount: sign-in page reachable,
  callback routes refuse GET without state, protected routes return the
  declared `onDeny`.

## 14. What this spike does not recommend

- A risk engine. New-device and step-up signals are enough for a first
  release; scoring by IP reputation or behavior is operator territory.
- Storing JWTs in the browser or issuing JWTs for sessions.
- Choosing a CAPTCHA vendor. The `challenge` hook lets the operator plug one.
- SMS as the only second factor. NIST restricts it; the YAML must opt in and
  the audit warns when no non-SMS factor is declared.
- Automatic account linking on email match.
- Provider or sender settings in `auth.yaml`.

## 15. Suggested sequence

Ordered so that every step ships something usable with no external service,
and the steps that need one come once the senders and providers exist.

1. Runtime PRs, generic: `extension` routes and the `extensions` block,
   plugin-registered policy modules, the context bag and `auth` binding,
   the store binding with indexes, expiry and transactions, the cache
   bypass on the session cookie, the Cloudflare `--extension` build
   option. Links keep working unchanged on the promoted store.
2. No-external-service release: schema, presets, `validate`, `init`, the
   SQLite store with export and import, resumable flow records, sessions
   with device list and remote sign-out, registration, identifier-first
   sign-in, password with breach check, enumeration-safe responses,
   per-account and per-client limits, the `challenge` hook, the accounts
   page (Tailwind and shadcn/ui), audit log, terms acceptance by version,
   personal-data export, deletion with a grace period. Tests through the
   plugin seam.
3. Second factor: passkeys, TOTP, recovery codes, trusted devices, step-up
   re-authentication for sensitive actions, second-factor policy.
4. Messaging: file and console senders, SES and Twilio, verification,
   codes, forgot password, lost second factor, new-device and change
   notifications, recovery contacts with cooldown and old-contact notice,
   `doctor`.
5. Google and Apple, explicit account linking after re-authentication.
6. RBAC, `protect`, bearer tokens and hashed API keys, admin CLI with
   impersonation off by default, compliance rules and deployment checks.
7. Organizations, invitations, teams, SSO, SCIM.

## 16. Open questions

- The four runtime seams are the real decision: `extension` routes with an
  `extensions` block, plugin-registered policies, the context bag with a
  guest binding, and the store binding. Each is generic; auth is the first
  user.
- Store backends: Postgres and D1 are each a project of their own; which
  ships first depends on where the first real deployment goes.
- Argon2id in WASM versus PBKDF2 as the portable default: the security
  choice is Argon2id; the operational cost on Workers needs a measurement.
- Which templates ship for email and SMS, and in which languages?
- Whether the accounts page is also where organization admin lives later or
  that becomes a separate mount.
