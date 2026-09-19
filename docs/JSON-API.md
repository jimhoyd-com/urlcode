# JSON form-endpoint API (contract `@1`)

Every route the `auth` extension serves under its mount (`/account` in the
examples below; the actual path is whatever the project routes to the `auth`
extension) branches on content negotiation: send `Accept: application/json`
(or, on a request with a body, `Content-Type: application/json`) and you get
a JSON body back instead of an HTML screen or a same-origin redirect. The
negotiation itself is `wantsJson()` in `src/auth-ui.ts`. This document is the
stable, versioned contract for the JSON side, the counterpart to the `auth/*`
HTML view models that `urlcode-ui doctor` checks for drift (`docs/SPIKE-AUTH.md`,
`src/auth-templates.ts`).

**This is documentation of already-shipped behavior.** Nothing here changes a
response shape; it names what the handlers in `src/auth.ts`, `src/auth-ui.ts`,
`src/auth-flows.ts`, `src/auth-signup.ts`, `src/second-factor-flows.ts`,
`src/factor-recovery.ts`, `src/manual-recovery.ts` and `src/abuse-http.ts`
already return.

## Versioning

Each endpoint group below carries a version tag, `@1` to start, next to its
heading — mirroring how each `auth/*` template declares `name@1` in
`src/auth-templates.ts`. The rule:

- **Adding an optional field, or a field only some responses include, does
  not bump the version.** Response shapes below already show which fields are
  conditional; a client must tolerate a field being absent.
- **Removing a field, renaming a field, changing a field's type or JSON
  structure, or changing which HTTP status a case returns is a breaking
  change.** It bumps that endpoint group's tag (`@1` → `@2`) and gets an entry
  in the changelog at the bottom of this file. Do this in the same change
  that alters the handler.
- Endpoint groups version independently, the same way individual templates
  do — changing one endpoint's shape does not bump the others.
- `test/json-api-contract.test.ts` asserts the exact key set (one level deep)
  of a handful of load-bearing endpoints against this document, so a shape
  drift on those endpoints fails CI. It is intentionally not exhaustive
  (see "What is and isn't covered" below); treat this document, not the test,
  as the source of truth for every endpoint's contract.

## Conventions used below

- **Mount**: every path is written relative to wherever the project mounts
  the `auth` extension, e.g. `/account/*`. Prefix accordingly.
- **JSON body headers**: every JSON response carries
  `content-type: application/json; charset=utf-8`, `cache-control: no-store`,
  and a locked-down `content-security-policy` (`src/auth-ui.ts`'s
  `jsonResponse`). These are omitted from the per-endpoint notes below.
- **CSRF**: every state-changing request needs a CSRF token, either as the
  `x-csrf-token` header or a `csrf` field in the body, bound to the caller's
  session or flow cookie. `GET .../csrf` is how a JSON client obtains one
  before it has a session.
- **The 303 redirect envelope**: a number of endpoints — reached from both
  HTML forms and JSON clients — reply with HTTP 303, a `location` header,
  and a body of exactly `{"redirect": "<path>"}`, **regardless of the
  `Accept` header**. A browser following the HTML form flow ignores that
  body and navigates by the `Location` header; a JSON client using
  `redirect: "manual"` reads `redirect` from the body instead. These are
  called out per-endpoint as "**always** `{redirect}`".
- **AuthUser** (`src/auth-core.ts`) fields: `id`, `email`, `emailVerified`,
  `status` (`'active' | 'locked' | 'pending-delete'`), `roles: string[]`,
  `created`, `totpEnabled` and `profile` (`{displayName?, locale?, metadata?,
  termsAccepted?}`, `{}` when nothing was submitted) are always present.
  `passkeyMfaEnabled` and `observedLastSeen` are present only when set.
- **AuthSession** fields: `id`, `created`, `authenticatedAt`, `expires`
  always present; `lastSeen` and `deviceLabel` only when known.

## Session and identify

### `GET /csrf` `@1`
`200 {csrf: string}`

### `POST /identify` `@1`
HTML-only; always returns the password-entry screen (200) or a validation
error. There is no JSON body for this endpoint — it exists to render the
next HTML step, not to hand back data. (Errors still follow the standard
error shape below.)

## Sign-in, registration, email code

### `POST /login` `@1`
- Success — `wantsJson`: `200 {user: AuthUser, csrf: string, restrictions?: string[]}`, session cookies set. `restrictions` (`('verify-email' | 'enroll-mfa')[]`) is present only when the account has outstanding enrollment requirements.
- Success — not `wantsJson`: **always** `{redirect: "<mount>/account"}` (303 envelope), session cookies set.
- Failure: standard error shape (401 for bad credentials/second factor, etc; see "Errors" below). On the HTML path only, a failed `/login` re-renders the password screen instead of an error page — JSON clients always get the plain error shape.

### `POST /register` `@1`
Same shape as `/login` but `201` on success (`200` is never returned for register), and only when the registration mode is `open` or `invite-only` with a successful invitation. Honeypot trip or `waitlist` mode instead returns:
- `202 {message: string}` (`wantsJson` and non-`wantsJson` alike — this one is not content-negotiated).

### `POST /send-email-code` `@1`
`200 {message: string, flowId: string}` (`wantsJson`); otherwise the email-code entry screen. Always attempted even for unknown emails (no user enumeration): `message` doesn't confirm the account exists.

### `POST /email-code` `@1`
Same success/redirect shape as `/login` (`{user, csrf, restrictions?}` / `{redirect}` envelope), consuming the code issued by `/send-email-code`.

### `POST /forgot-password` `@1`
`200 {message: string}` (`wantsJson`); no user-enumeration signal either way.

## Email confirmation tokens

### `POST /verify-email-change` `@1`
`200 {changed: true}`, session cookie cleared (the account must sign in again with the new email).

### `POST /cancel-email-change` `@1`
`200 {cancelled: true}`.

### `POST /cancel-deletion` `@1`
`200 {cancelled: true}`.

### `POST /verify` `@1`
- If the operator requires email verification before sign-in: `200 {verified: true, signInRequired: true}`, session cookie cleared.
- Otherwise: `200 {verified: true}`.

### `POST /reset` `@1`
`200 {reset: true}`, session cookie cleared.

## OIDC providers (`/providers/<name>/...`)

### `POST /providers/<name>/start` `@1`
**Always** `303 {redirect: "<provider authorization URL>"}` (not content-negotiated) plus a `set-cookie` binding the browser to the flow.

### `POST /providers/<name>/link` `@1`
Same as `start`, for linking a provider to an already-signed-in account (requires a fresh session).

### `GET`/`POST /providers/<name>/callback` `@1`
One of, depending on account state:
- Existing account, no second factor: `finish()` result — `wantsJson`: `200 {user, csrf, restrictions?}`; else **always** `{redirect: "<mount>/account"}` (303 envelope).
- Linking an identity to the current session: **always** `303 {linked: true}` (not content-negotiated), `location: <mount>/account`.
- New account and enrollment fields are required: **HTML only** — renders `auth/provider-enroll`. There is no JSON body for this branch; a JSON-only client cannot complete this path today (tracked as a gap — see the filed issue below).
- New account with an existing MFA requirement (second factor already enabled on that email, unusual but possible via prior admin action) or step-up needed: **HTML only** — renders `auth/provider-second-factor`. Same JSON gap as above.

### `POST /providers/enroll` `@1`
`finish()` result, same shape as a successful callback.

### `POST /providers/complete` `@1`
`finish()` result, same shape as a successful callback.

## Passkeys — primary and step-up ceremonies (`/passkeys/{register,login,step-up}/{options,verify}`)

These four endpoints are **JSON-only** — there is no HTML fallback; `passkeyScript` in `src/auth-ui.ts` is the only intended caller, always sending `Accept: application/json`.

### `POST /passkeys/{register,login,step-up}/options` `@1`
`200 {options: <WebAuthn creation/request options, provider-shaped>, flowId: string}`.

### `POST /passkeys/register/verify` `@1`
`200 {registered: true}` (adds the passkey to the signed-in account).

### `POST /passkeys/login/verify` `@1` / `POST /passkeys/step-up/verify` `@1`
`finish()`/`completeStepUp()` result:
- `login`: same as a successful `/login` (`{user, csrf, restrictions?}` or the `{redirect}` envelope).
- `step-up`: `200 {confirmed: true, csrf: string, restrictions?: string[]}` (see "Step-up" below) or, on the non-JSON path, a redirect to `/account`.

## Second-factor proof (`/second-factor/options`, `/second-factor/verify`)

JSON-only, same as the passkey ceremonies above. Produces an opaque, single-use `secondFactorToken` that a subsequent primary action (login, change-password, delete, etc.) submits alongside its own proof.

### `POST /second-factor/options` `@1`
`200 {flowId: string, options: <WebAuthn request options>}`.

### `POST /second-factor/verify` `@1`
`200 {secondFactorToken: string}`.

## Signup wizard (`/signup/...`)

### `GET /signup` `@1`
`200 {step: 'identifier' | 'verify-email' | 'credential' | 'profile', csrf: string, expires?: number}`. `expires` is present once a signup flow is in progress (the cookie-bound state has a TTL); absent for a fresh visitor (`step` reads `'identifier'` in that case, standing in for "no flow yet").

### `GET /signup/pending` `@1`
`200 {pending: true}` (waitlist mode, after `/signup/complete`).

### `POST /signup/begin` `@1`
`200 {step: SignupState['step'], expires: number}` (`wantsJson`); otherwise a 303 redirect to the signup screen.

### `POST /signup/verify` `@1` / `POST /signup/password` `@1`
`200 {step: SignupState['step']}` — the shared "advance one step" response used by both.

### `POST /signup/passkeys/options` `@1`
JSON-only: `200 {options: <WebAuthn creation options>}`.

### `POST /signup/passkeys/verify` `@1`
JSON-only: `200 {step: 'profile'}`.

### `POST /signup/complete` `@1`
`200 {complete: true, redirect: string, csrf?: string}` (`wantsJson`). `csrf` is present only when an account/session was actually created (open/invite-only completion); absent when the request instead enters the review queue (`waitlist` mode) or matches an existing account (sign-in-only outcome). `redirect` is the next mount-relative path the caller should navigate to (`/account`, `/signup/pending`, or `/login`) — informational for a JSON client, since no navigation happens automatically.

### `POST /signup/restart` `@1`
**Always** `303 {redirect: "<mount>/signup"}` (not content-negotiated).

## Second factors, trusted devices, sessions, methods (signed-in account)

### `GET /account` `@1`
`200 {user: AuthUser, csrf: string, restrictions?: string[], impersonatorId?: string}`. `restrictions` present only during incomplete enrollment; `impersonatorId` present only when an administrator is impersonating this account.

### `GET /second-factors` `@1`
`200 {passkeys: {id: string, secondFactor: boolean}[], csrf: string}`. 404 if passkey second factors are not configured.

### `GET /trusted-devices` `@1`
`200 {devices: {id: string, label: string, created: number, expires: number}[], csrf: string}`. 404 if the feature is disabled.

### `GET /sessions` `@1`
`200 {sessions: AuthSession[], csrf: string}`.

### `GET /methods` `@1`
`200 {passkeys: {id: string, transports?: string[]}[], identities: {provider: string, subject: string}[], csrf: string}`.

### `POST /passkeys/second-factor` `@1`
`200 {updated: true}`.

### `POST /trusted-devices/remember` `@1`
`200 {remembered: true, expires: number}`, sets the trusted-device cookie (capped at 30 days even if the policy TTL is longer).

### `POST /trusted-devices/revoke` `@1`
`200 {revoked: true}`, clears the trusted-device cookie.

### `POST /passkeys/remove` `@1`
`200 {removed: true}`.

### `POST /providers/unlink` `@1`
`200 {unlinked: true}`.

## Account management

### `POST /change-email` `@1`
`200 {requested: true, activateAfter: number}` — the change only activates after the cooling-off period; `activateAfter` is that unix-ms timestamp.

### `POST /revoke-session` `@1`
`200 {revoked: true}`.

### `POST /profile` `@1`
`200 {profile: RegistrationProfile}` — the updated profile object (`displayName?`, `locale?`, `metadata?`, `termsAccepted?`), not wrapped further.

### `GET /export` `@1`
**Always** JSON regardless of `Accept` (this is the one GET endpoint that is not content-negotiated — it is a download). `200 {user: AuthUser, sessions: AuthSession[], passkeys: {id: string, transports?: string[]}[], identities: {provider: string, subject: string}[]}`, with `content-disposition: attachment; filename="account.json"`.

### `POST /change-password` `@1`
`200 {changed: true}`, session cookie cleared (re-authentication required).

### `POST /delete` `@1`
`200 {deletionScheduled: true, deleteAfter: number, cancellationDays: number}`, session cookie cleared.

### `POST /logout` `@1`
`200 {signedOut: true}`, session cookie cleared.

### `POST /revoke-sessions` `@1`
`200 {signedOut: true}`, session cookie cleared (signs out every session, not just the current one).

## Step-up, TOTP

### `POST /step-up` `@1`
`200 {confirmed: true, csrf: string, restrictions?: string[]}`, session (re-)issued with a fresh `authenticatedAt`.

### `POST /send-verification` `@1`
`200 {message: string}`.

### `POST /totp/begin` `@1`
`200 {secret: string, otpauthUrl: string}` — the raw enrollment object, **not wrapped** in an envelope (no `csrf` key here; use the session cookie/CSRF already in hand).

### `POST /totp/confirm` `@1`
`200 {recoveryCodes: string[]}` — again unwrapped.

### `POST /totp/disable` `@1`
`200 {disabled: true}`.

## Factor recovery (`/recover-factor/...`)

Opt-in, lower-assurance email fallback when the account's regular second factor is unavailable. 404 if the operator hasn't enabled it.

### `POST /recover-factor` `@1`
`200 {message: string}` — no user-enumeration signal.

### `POST /recover-factor/cancel` `@1`
`200 {cancelled: true}`.

### `POST /recover-factor/confirm` `@1`
`200 {completeAfter: number, expires: number}` — the raw service result, unwrapped.

### `POST /recover-factor/complete` `@1`
- `wantsJson`: `200 {enrollmentRequired: true, user: AuthUser, csrf: string}`, session cookie set. `enrollmentRequired` is always `true` here — this path always drops the account into the enrollment flow rather than full access, since email-based recovery is lower assurance.
- not `wantsJson`: **always** `{redirect}`-shaped, but with `enrollmentRequired: true` in the body instead of `redirect` — i.e. `303 {enrollmentRequired: true}`, `location: <mount>/account`.

## Manual account restoration (`/restore-access`)

Operator-approved recovery case redemption (`src/manual-recovery.ts`). 404 if manual recovery isn't enabled.

### `POST /restore-access` `@1`
Same two-shape split as `/recover-factor/complete`: `wantsJson` gets `200 {enrollmentRequired: true, user, csrf}`; otherwise `303 {enrollmentRequired: true}` with a `location` header.

## Abuse guard (applies before the endpoint's own logic, on entry points only)

Entry points: `/login`, `/register`, `/signup/begin`, `/forgot-password`, `/send-email-code`, `/recover-factor`, `/passkeys/login/options`, `/providers/<name>/start`.

### Honeypot trip on a signup entry point `@1`
`202 {message: string}` — not content-negotiated, same as the `/register` honeypot case above.

### Challenge required and not satisfied `@1`
- `wantsJson`: `403 {error: string, challengeRequired: true}`.
- not `wantsJson`: the `auth/status` HTML screen, 403.

## Errors (all endpoints unless noted otherwise above)

The default shape from `httpFailure()` in `src/auth-ui.ts`:

`{error: string} @1`

with the HTTP status carried on the response (a thrown `AuthHttpError`'s
`status`, or `500` for anything unrecognized — internal messages are never
leaked, `error` reads `"Service unavailable"` instead). Two endpoints extend
this base shape with extra fields:

- Blocked by incomplete enrollment (any endpoint outside the fixed enrollment
  allow-list, once the account has outstanding `restrictions`): `403 {error: string, restrictions: string[]}`.
- `405 Method Not Allowed`: `{error: string}` plus an `allow` response
  header listing the permitted methods.

A route-level authorization policy (`policies.extensions.auth` in
`urlcode.yaml`, independent of the endpoints above) denies with
`{error: string}` at the status the policy names (`onDeny`), defaulting to
`401` signed-out / `403` signed-in-but-not-permitted.

## What is and isn't covered

Documented above: every endpoint reachable through `src/auth.ts`,
`src/auth-flows.ts`, `src/auth-signup.ts`, `src/second-factor-flows.ts`,
`src/factor-recovery.ts`, `src/manual-recovery.ts` and `src/abuse-http.ts`
that returns or can return a JSON body.

Not attempted here, deliberately out of scope for a documentation-only pass:

- A generated/automated drift checker equivalent to `urlcode-ui doctor` for
  the HTML view models. `test/json-api-contract.test.ts` instead hand-checks
  the exact key set of a handful of load-bearing endpoints (`/csrf`,
  `/register`, `/account`, `/sessions`, `/methods`, `/logout`) against this
  document. The existing HTTP suites (`test/auth-http.test.ts`,
  `test/signup-http.test.ts`, `test/mfa-http.test.ts`,
  `test/factor-recovery.test.ts`, `test/manual-recovery-http.test.ts`,
  `test/second-factor-flows.test.ts`, `test/passkey-handler.test.ts`,
  `test/providers.test.ts`, `test/abuse-http.test.ts`) already exercise the
  values inside these bodies functionally; they were the source for this
  document, cross-referenced against the handler source in each file above.
- The two OIDC callback branches that render `auth/provider-enroll` and
  `auth/provider-second-factor` have no JSON body at all today (HTML-only,
  noted inline above) — filed as a gap on the `urlcode-auth` issue tracker
  rather than silently changed here, since adding one is a runtime behavior
  change outside this documentation task.

## Changelog

- `@1` (this document, 2026-09): initial published contract, describing the
  JSON shapes already returned by every `auth` route as of this revision.
  No runtime behavior changed to produce this document.
