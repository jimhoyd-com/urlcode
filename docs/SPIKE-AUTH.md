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
(section 3) is what fills the gap list beyond the requested feature set.

## 1. Principles carried over

- **Behavior in YAML, infrastructure outside it.** `auth.yaml` declares
  methods, policies, roles and pages. Twilio credentials, SES regions, Google
  client secrets and Apple signing keys are operator material bound in host
  code or an operator file outside the checkout, the same way function
  bindings are granted today ([function security](FUNCTION-SECURITY.md)). If
  someone else takes the YAML it works with their own senders and providers.
- **Standards first.** Every flow maps to a published standard (section 5),
  so the YAML names known behavior rather than this package's opinion.
- **The plugin seam, not a fork of the runtime.** The package is a host
  plugin on the existing hook seam ([plugins](PLUGINS.md)): it sees each
  matched request before the handler and each response before it is written.
  Nothing in `urlcode.yaml` names the package; the operator passes it to
  `startServer` or an adapter. Section 6 lists the three small core seams the
  plugin needs that do not exist yet.
- **Untrusted application code.** Guest functions never see credentials,
  password hashes, session secrets or provider tokens. They get a narrow,
  grantable binding that answers "who is this and what may they do".
- **Portable state.** Accounts, sessions and credentials live in a
  worker-isolated SQLite store with the export and restore discipline of the
  [link store](DYNAMIC-LINKS.md). Serverless targets that cannot hold a
  durable store are refused at activation, not silently degraded.
- **Off unless declared.** No method, page or channel exists until
  `auth.yaml` declares it. A project with an empty `methods` block has no
  way to sign in and says so at activation.

## 2. Shape of the package

```
@jimhoyd/urlcode-auth
  auth.yaml              declared by the project (portable)
  senders / providers    bound by the operator (not portable, not in YAML)
  store                  SQLite by default, one interface, operator-replaceable
  pages                  server-rendered account pages, overridable per file
  api                    JSON endpoints under the same mount for SPA integrators
  cli                    urlcode-auth users|roles|sessions|export|import
```

Operator wiring, the only non-YAML part:

```js
import { startServer } from '@jimhoyd/urlcode';
import { urlcodeAuth } from '@jimhoyd/urlcode-auth';
import { twilioSms, sesEmail } from '@jimhoyd/urlcode-auth/senders';

await startServer({
  project: './site',
  plugins: [urlcodeAuth({
    config: './site/auth.yaml',
    store: './var/auth.sqlite',           // outside the checkout
    secrets: process.env,                 // AUTH_SESSION_KEY, GOOGLE_CLIENT_SECRET, …
    senders: { sms: twilioSms(process.env), email: sesEmail(process.env) },
  })],
});
```

`auth.yaml`, all keys optional except `version`, `methods` and `session`:

```yaml
version: "1"
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
pages:                               # optional overrides of the shipped pages
  signIn: auth/sign-in.html
  layout: auth/layout.html
organizations:                       # section 8: reserved and validated, inactive
  enabled: false
```

Everything above is checked against a JSON schema on load (unknown keys
rejected, the same discipline as `urlcode.yaml`), and `urlcode-auth validate`
runs it without starting a server.

## 3. What Google, Uber, Airbnb and the open-source projects do

The requested list (password, Google, Apple, passkey, phone/SMS, email,
recovery, organizations, accounts page) is the surface a user sees. The
following is what the products people trust do underneath, and what the
open-source projects have converged on. Items marked **gap** were not in the
request and are added to the proposal.

### Consumer products

| Practice | Google | Uber | Airbnb | Added to proposal |
|---|---|---|---|---|
| Passkeys as the default sign-in, password as fallback | yes | yes (2024) | yes | `passkey` first in `methods`; usernameless via discoverable credentials |
| Phone number as a primary identifier | secondary | **primary** | primary or email | **gap**: `identifier: [email, phone, username]` per project |
| One-time code by SMS or email instead of a password | yes | yes | yes | `emailCode`, `smsCode` methods |
| Second step (2SV) with authenticator, SMS, prompt, security key | yes | yes | yes | `secondFactor` block, TOTP, passkey, codes |
| Risk-based step-up (new device, new country, sensitive action) | yes | yes | yes | **gap**: `stepUp` for sensitive actions, `newDevice` signal; full risk engine out of scope |
| "New sign-in on device X" notification | yes | yes | yes | `notifications.newDevice` |
| Trusted devices ("don't ask again on this device") | yes | yes | yes | `session.rememberDevice` |
| Device and session list with remote sign-out | yes | yes | yes | accounts page: sessions tab, revoke one or all |
| Recovery phone and recovery email, separate from sign-in identifiers | yes | yes | yes | **gap**: recovery contacts distinct from identifiers |
| Recovery codes for lost second factor | yes | no | no | `secondFactor.recoveryCodes` |
| Cooling-off period after recovery contact changes | yes (7 days) | yes | yes | **gap**: `recovery.cooldown`, changes to recovery contacts take effect after a delay, notice to the old contact |
| Re-authenticate before sensitive changes (password, email, delete) | yes | yes | yes | **gap**: `stepUp.actions: [changePassword, changeEmail, deleteAccount, addPasskey]` |
| Account enumeration resistance on sign-up, sign-in, forgot password | yes | yes | yes | identical responses and timing; codes sent whether or not the account exists |
| Password breach check, no composition rules, paste allowed | yes | n/a | yes | `password.breached`, NIST 800-63B rules |
| Account linking (same email via Google and password) | explicit | explicit | explicit | **gap**: link only after a verified email match and an explicit confirmation, never automatic |
| Sign in with Apple private relay emails | yes | yes | yes | Apple relay address stored as-is; email change flow handles relay |
| Account deletion with a grace period and export | yes (Takeout) | yes | yes | **gap**: `deletion: { grace: 30d }` and per-account export of personal data |
| Consent and terms acceptance recorded with version | yes | yes | yes | **gap**: `terms: { version, url }`, acceptance stored with timestamp |
| Rate limiting per account and per client, CAPTCHA on pressure | yes | yes | yes | `limits`, plus a **gap**: `challenge` hook so an operator can plug a CAPTCHA or Turnstile without the package choosing one |

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
  the data model (section 7).
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
  WorkOS-style products). Reserved, section 8.

What none of them do that this proposal keeps: the YAML is the whole
declaration and it is checked by the same audit, compliance and route-diff
tooling as the rest of a URLCode project, so an auth change shows up in the
project's pull request check like any other route change.

## 4. Flows

Each flow is a resumable record (`flow_id`, kind, state, expires) so a page
reload or a second device does not lose progress. All pages and JSON
endpoints live under `mount`.

**Sign-up.** Identifier (per `identifier` order) → method (password,
passkey, provider, code) → verification if `verification` requires it →
terms acceptance if declared → session. Response is identical whether the
identifier already exists; an existing account receives a "someone tried to
sign up with your email" notice instead.

**Sign-in.** Identifier or usernameless passkey → first factor → second
factor if the policy or the account requires it, skipped on a trusted device
→ session. Provider sign-in (Google, Apple) goes through the authorization
code flow with PKCE, `state` and `nonce`; the callback is the only route that
accepts the provider redirect. Unknown-provider-identity plus a verified
matching email offers linking after re-authentication, never silently.

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

## 5. Standards each part maps to

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

## 6. Core seams the plugin needs

The plugin contract today lets a plugin answer or observe a request. Three
small additions to the runtime would let auth work without forking it. Each
is generic, not auth-specific.

1. **A request context bag.** `PolicyRequest.context: Map<string, unknown>`
   that plugins may populate in `onRequest` and native handlers, middleware
   and the guest binding may read. The auth plugin puts a frozen
   `{ principal, roles, permissions, session }` summary there. Guests never
   see the raw map, only what a granted binding exposes.
2. **A grantable `auth` binding for functions.** Exposed through the existing
   operator grant file, so a function on an approved route can call
   `auth.principal()` and `auth.can('content.write', resource)`. It reads the
   context bag, holds no credentials and cannot sign anyone in.
3. **A plugin-declared route table.** Plugins can already answer any request,
   but the accounts page, callbacks and JSON API should appear in
   `urlcode routes`, the audit, the route diff and the site conventions
   (robots `disallow` for `mount`). A plugin returning native routes at
   activation, merged like `site` routes with declared routes winning, gives
   that for free.

Interoperability with the five policies, in pipeline order: `agents` may
block bots from auth pages (fine); `throttle` runs before auth so the package
adds per-account limits on top of the per-client ones rather than replacing
them; `cache` must never store an authenticated response, so the plugin marks
its responses `no-store` and adds `Vary: Cookie` on protected routes, and the
runtime's cache policy already bypasses on `Authorization` and should learn
the same for the session cookie name; `security` headers apply unchanged;
`compression` is disabled on auth pages by the plugin's response hook.

Targets: `node` fully. `vercel` and `aws` only with an operator-supplied
external store (the SQLite store is refused at activation because there is no
durable filesystem). `cloudflare` refused: the build carries no plugins.

## 7. Data model (SQLite, worker-isolated, exportable)

```
accounts        id, status (active|locked|pending-deletion), created, deleted_at, terms_version, org_id (null until section 8)
identifiers     account_id, kind (email|phone|username), value (normalized), verified_at, primary, unique(kind, value)
credentials     account_id, kind (password|passkey|totp|provider|api-key|recovery-code), data (json: hash+params | credential id+public key+counter+transports | provider subject), created, last_used, name
sessions        id (opaque, hashed), account_id, created, last_seen, expires, absolute_expires, device (ua family, client), trusted_until, revoked_at
flows           id, kind, state (json), account_id?, expires
codes           flow_id, channel, hash, expires, attempts, sent_to
recovery_contacts account_id, kind, value, verified_at, effective_at   (effective_at implements the cooldown)
roles           name, permissions (json), org_id?
assignments     account_id, role, org_id?, resource?
audit           id, at, actor, action, subject, detail (json), request_id
cases           id, account_id, kind, opened, state, notes   (manual recovery)
```

Normalization: emails lower-cased and Unicode-normalized with the local part
kept as-is except for case; phone numbers stored in E.164 after validation
against the declared `regions`. Every secret-bearing column holds a hash;
export writes the same rows with hashes intact so a restore is exact, and the
`urlcode-auth export --redact` variant strips them for support cases.

## 8. Organizations, teams and SSO: what to prepare now

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

## 9. Accounts page

Server-rendered HTML with no client framework, one page per flow step,
progressive enhancement only (passkeys need a few lines of script for
`navigator.credentials`). Shipped pages are plain templates with named slots
(`layout`, `signIn`, `signUp`, `verify`, `recover`, `settings`, `sessions`,
`security`, `data`), and `pages` in YAML overrides any of them with a file
in the project, so a project brands the pages without touching the package.
Every page sends `Cache-Control: no-store`, the project's security headers,
and a per-flow CSRF token in addition to the same-origin check. The JSON API
under `mount/api/*` mirrors each step for single-page apps and mobile
clients, with the same flow ids.

## 10. Operations

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

## 11. What this spike does not recommend

- A risk engine. New-device and step-up signals are enough for a first
  release; scoring by IP reputation or behavior is operator territory.
- Storing JWTs in the browser or issuing JWTs for sessions.
- Choosing a CAPTCHA vendor. The `challenge` hook lets the operator plug one.
- SMS as the only second factor. NIST restricts it; the YAML must opt in and
  the audit warns when no non-SMS factor is declared.
- Automatic account linking on email match.
- Provider or sender settings in `auth.yaml`.

## 12. Suggested sequence

1. Core seams (section 6) as a runtime PR: context bag, `auth` binding,
   plugin route table, cache bypass on the session cookie.
2. Package skeleton: schema, `validate`, SQLite store with export and
   import, sessions, password, sign-up, sign-in, sign-out, settings, the
   accounts page, per-account limits. Tests through the plugin seam.
3. Email and SMS senders, verification, codes, forgot password, lost second
   factor, notifications, recovery contacts with cooldown.
4. Passkeys, TOTP, recovery codes, trusted devices, second-factor policy.
5. Google and Apple, account linking with re-authentication.
6. RBAC, `protect`, bearer tokens and API keys, admin CLI, audit export,
   compliance rules and deployment checks.
7. Organizations, invitations, teams, SSO, SCIM.

## 13. Open questions

- Does the runtime accept the three core seams, or should the plugin keep
  everything behind its own mount and hand identity to guests some other
  way? The context bag is the smallest change and the one every other
  plugin could use.
- Store interface: SQLite first with Postgres as the second implementation,
  or design the interface against both from the start?
- Should `identifier` default to `[email]` or require an explicit choice?
  Uber's phone-first model argues for explicit.
- Which templates ship for email and SMS, and in which languages?
- Whether the accounts page is also where organization admin lives later or
  that becomes a separate mount.
