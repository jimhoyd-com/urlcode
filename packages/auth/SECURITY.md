# Security boundary

This repository is an actively reviewed implementation, not an independent security assessment or a hostile multi-tenant authentication platform. Report a suspected vulnerability privately using the security reporting channel on the repository hosting this reviewed source; do not include passwords, session cookies, live recovery tokens or customer databases in public issues. If no private reporting channel is configured, ask the maintainer for one before sending sensitive details.

## Trusted and untrusted components

Operator modules, their dependencies, configuration, database directory, encryption/CSRF keys, identity providers and mail transport are trusted. Project routes are trusted and run in-process with full Node access by default; `sandbox: true` opts a route into the isolated QuickJS/WASM worker pool instead. Project YAML cannot register auth's host modules: activation requires the explicit host-file/operator-registration mechanism. This is not a confinement boundary for trusted Node code, which can independently import accessible modules and read process environment/files with the host user's authority. Only an explicitly sandboxed route has the guest isolation boundary. Core extension activation requires an explicitly supplied registry and a reviewed exact project revision pin. Never turn revision inspection into automatic approval.

Auth is Node/SQLite only. It refuses unpatched SQLite versions and requires private database files. Keep the database, WAL/SHM, backups, operator modules and key files outside the application project and inaccessible to guest filesystem access. Do not run the host as a shared hostile operating-system user. Filesystem permission and symlink checks do not defend against an attacker who already controls the operator account or its parent directories.

**Same-origin browser JavaScript is trusted.** HttpOnly cookies and stripped guest server headers do not isolate frontend JavaScript served on the account origin. Such JavaScript can fetch a CSRF value and send requests with ambient cookies. Serve only reviewed frontend content on that origin, or isolate the authentication surface on a different origin with explicit narrowly scoped integration. A WASM sandbox for server code is not a browser-content sandbox.

## Authentication and authorization

Use HTTPS with a canonical operator-specified origin, never an untrusted Host header. Cookies are Secure, HttpOnly and host-scoped. Unsafe HTTP operations require unambiguous same-origin provenance (core's single rule: a site `Origin`, or `Sec-Fetch-Site: same-origin` when `Origin` is absent; `cross-site`, duplicated headers and no provenance are refused) and a session-bound CSRF token in one `x-csrf-token` header or a `csrf` body field. A route may opt into `auth: {csrf: origin}`, which drops the token and relies on that provenance and the `SameSite=Strict` `__Host-` session cookie; use it only on a mount that verifies its own token or accepts JSON only. An XSS or compromised trusted dependency can cross this boundary; CSRF tokens do not prevent same-origin XSS.

Passkeys use the canonical host as the WebAuthn relying-party ID and accept ceremonies only from the canonical origin, unless the operator sets a shared RP ID (`--passkey-rp-id`, issue #729). Then every site origin (canonical and operator alias origins) under that registrable domain can register and use the same passkeys, and each of those origins must be trusted to the same degree as the canonical one: script on any of them can run a passkey ceremony for the shared RP ID. Browsers additionally let any subdomain of the RP ID request assertions for it, so do not choose an RP ID whose other subdomains serve untrusted content; server verification still accepts only listed site origins. Core refuses IP addresses, single labels and a short list of public suffixes; browsers enforce the full Public Suffix List. Changing the RP ID strands existing passkeys (users re-register). Auth records the RP ID each passkey was registered under and warns at activation (core's `warning` event) when stored passkeys belong to another RP ID than the effective one (#736); the warning does not stop the site.

Session tokens are opaque and stored as hashes — including in encrypted flow records that must survive a cross-site redirect (for example, the OIDC identity-link flow), which persist a session's hash reference (`sessionReference()`) rather than the raw bearer token. TOTP/recovery/code consumption and administrative invariants use transactions. Role changes and account state changes invalidate relevant sessions. Fresh authentication, ceilings and last-administrator checks are service responsibilities, not UI-only safeguards. Use actor-bound administrative methods for delegated users; unrestricted operator methods are not HTTP authorization APIs. Another extension gets `AuthExports` v1 only: the signed-in account, a CSRF token for the current session, auth's URLs and the administration API, whose every call names an opaque actor auth minted from that request's session and re-checks it. No key, database handle, cookie or raw token leaves auth; auth sends every credential-bearing email itself, including those an administrator starts. A flow's browser binding is checked before the flow is consumed, so a request replayed from the wrong browser cannot spend a flow the right browser still needs.

Impersonation is opt-in, excludes privileged targets, expires, and denies account security/administrative mutations. Auth's middleware shows a support banner and marks responses uncacheable on every route an auth policy guards; a route with no auth policy gets neither, so do not assume a banner on public pages. Never expose an unrestricted issueSession or operator service method to a client.

Email verification is optional by default, so an unverified account may have been registered by someone who does not control its address. Its first mailbox proof removes every sign-in method, factor, device trust and session established before it, and the password unless the proof sets one or comes from that account's own signed-in browser. Treat `emailVerified` (and the `verified` route requirement) as mailbox proof by the current holder, not as a history of who used the account before. An administrator's manual verification does not perform this removal; review the account's methods first.

Metadata is never a permission source. Private fields must stay out of public projections; public/unsafe fields are untrusted. Render translated/user text as text, not markup. Operator theme inputs are constrained; arbitrary project templates are deliberately excluded.

Bearer/API keys are a separate credential kind from sessions, meant for machine/agent callers rather than browsers: no cookie, no CSRF proof, checked against the `Authorization: Bearer <key>` header on routes that declare `auth: {bearer: {scopes:[...]}}`. Issued keys are `uak_<id>.<secret>`: `id` is a public lookup identifier, `secret` is hashed at rest with the same scrypt derivation used for passwords (bounded by the same hash-slot budget) rather than a fast digest, so lookup is always by `id`, never by hashing an incoming secret against every stored key. The raw key is returned once, at `issueApiKey` time, and is not recoverable from the store afterward. Expiry and revocation are enforced at verification time (`authenticateApiKey`); a revoked or expired key is indistinguishable from an unknown one to the caller (both are a 401 `invalid_token`). Scope strings are opaque route-declared labels the extension checks for membership; it does not interpret or hierarchically expand them. On success, the verified key's id/name/scopes (never the raw key) are written into the reserved `x-urlcode-context-auth-principal` request header as base64-encoded JSON, so the protected route's own trusted `function`/`middleware` can read who authenticated; a client can never inject or spoof that header, and it is never forwarded to a proxied upstream — see [urlcode#618](https://github.com/jimhoyd-com/urlcode/issues/618) and [handing data forward into a protected route's own context](../../docs/EXTENSIONS.md#handing-data-forward-into-a-protected-routes-own-context).

Auth also sets core's opaque request principal (`providesPrincipal`, [request principal](../../docs/EXTENSIONS.md#request-principal), #331) on every request its `authorize()` allows, and only then: the user's stable id for a session (after the CSRF check on a write; never the email), the linked user's id for a bearer key issued with `userId` (#732), or `apikey:<key id>` for a service key, which has no owning user. A user-linked key gains the user's data scope, not the user's authority: it is still gated only by its own scopes, never by the user's roles or permissions, and cannot pass a session-protected route. It authenticates only while the account is `active` (checked in the same lookup as revocation and expiry, so a lock or deletion takes effect on the next request), and the account's purge revokes it. Issuing one is an operator action; there is no self-service key issuance, so a user cannot mint a key for their own or anyone else's account. Other extensions on the route (an owned store collection) scope data by that id, so a denied, unauthenticated, enrollment-restricted or CSRF-failing request never carries one. An impersonation session carries the impersonated user's id.

A bearer route's optional `quota` bounds how much work one valid key can drive (urlcode#572). It is counted only after a key authenticates, so it is not a defence against guessing or unauthenticated floods — those remain core `policies.throttle`'s (per client, before auth). The counter is keyed by a SHA-256 of the key's public id and the budget, never the secret; a store failure refuses the request (503) rather than skipping the count. The count is per host (one SQLite file): several hosts each enforce the full budget. A key issued with its own `quota` is counted against that budget instead of the route's (urlcode#703); the budget is fixed at issuance by the operator and bounded like the route quota. Allowed responses report the credential's remaining budget in `RateLimit` fields; these are per credential, and core sends every response of an auth-protected route with `Cache-Control: no-store` and refuses a shared-cache strategy on such a route, so they are never stored or served to another caller.

## Operational limitations

Rate limits, worker bounds and request limits reduce specific abuse paths; they do not replace perimeter admission controls or deployment capacity testing. Review proxy/client identity configuration. Do not weaken MFA because an email/reset flow is inconvenient. Provider account linking must remain explicit and issuer/subject-scoped rather than inferred from matching email.

### Attempt budgets

`attempt()` in `src/auth-core.ts` backs every guessing/issuance ceiling with a per-key counter
(`auth_attempts` table), always over a 15-minute window unless noted. Every ceiling below is
independent of the others: exhausting one never blocks the others.

- **Password sign-in and password step-up** (guessable secret): two independent budgets — a
  tight one at 10 attempts, scoped to the account **and** the caller's network client when the
  runtime target supplies one (`request.client`; falls back to per-account only when it does
  not), and a much higher one at 30 attempts scoped to the account alone, so a distributed
  attacker using many clients against one account is still bounded. A failed password guess
  never spends passkey, OIDC or session-reauthentication budget, and vice versa — each has its
  own namespace (`login:password:`, `login:passkey:`, `login:oidc:`, `login:reauth:`).
- **Passkey/OIDC sign-in and passkey step-up** (not a guessable secret): 10 attempts per account,
  not client-scoped.
- **Password/session re-confirmation** (`changePassword`, `deleteAccount`,
  `requestEmailChange`): 10 attempts per account, in its own namespace so it cannot be exhausted
  by, or exhaust, an anonymous sign-in attempt against the same account. These require an
  existing valid session, so they are reachable only by someone who already holds one.
- **Password-reset and verify-email tokens**: 10 issuances per 15 minutes per account, namespaced
  separately per purpose (`token:reset-password:`, `token:verify-email:`) so exhausting one does
  not block the other.
- **Email sign-in codes and signup codes**: 10 issuances per 15 minutes per account (short
  window), **plus** a long-window cap of 20 issuances per 24 hours per account
  (`email-code:daily:`, `signup:daily:`) so per-code limits (a small per-code attempt count and a
  short expiry, enforced in `src/auth-store.ts`) cannot be defeated by simply re-issuing new
  codes indefinitely. Each ceiling responds `429 authentication_rate_limited`.
- **Password hashing**: bounded to two concurrent derivations process-wide
  (`src/auth-core.ts`'s `derive`), queued briefly before refusing with `503 password_hash_busy`
  — see "Password hashing concurrency" below.

These are defaults, not configurable per deployment today; an operator needing different
ceilings should track/file that as a feature request rather than patch the constants in place.

### Audit trail

Auth writes every privileged action as an event into its `auth_audit_outbox`
table in the same transaction as the change, and the audit extension drains
the outbox into its own log (`data/audit.sqlite`) while a host runs. A change
and its event commit together or not at all. When 10000 events wait
undelivered, the next privileged change answers `503 audit_backlog` and
changes nothing: auth fails closed rather than acting unaudited.
`urlcode-auth doctor` reports the backlog. Retention, queries and exports are
the audit extension's ([audit SECURITY](../audit/SECURITY.md)). Reading the
audit log needs the `audit.read` and `audit.export` permissions, which roles
grant like any other; auth no longer enforces audit reads itself. Registration
events (`registration.duplicate`, `registration.invited`) carry the email
address as their subject, so the log holds personal data.

### Abuse budgets

Sign-in and sign-up budgets, challenge escalation and password backoff are
enforced through the abuse extension when `extensions.auth.config.abuse`
declares them. Its counters are keyed by an HMAC of the client key or account
under `data/abuse.key`, never the raw value. The attempt budgets below are
independent of it and always apply.

### Password hashing concurrency

Password derivation (scrypt) is deliberately expensive and is bounded to a small number of
concurrent derivations process-wide so a burst of hashing cannot exhaust CPU. A caller that
cannot get a slot within a short bounded wait gets `503 password_hash_busy` rather than queuing
indefinitely. This budget is shared by every caller in the process (sign-in, registration,
password change); it is not per-client. Deployments expecting sustained concurrent password
traffic should scale horizontally (more processes) rather than relying on one process to absorb
unbounded concurrent hashing.

Emails can fail or be delayed. Preserve an operator recovery procedure for deletion cancellations, email changes and provider outages. Do not log token-bearing callback URLs, passwords, codes, session headers or mail bodies. Mail's development transports (the loopback `data/outbox/` default, console) write message bodies, including links and codes, in the clear; they are refused off the node target and the default is used only on a loopback origin.

Backups contain sensitive account records, undelivered audit events and password hashes. Preserve keys separately, retain the exact reviewed configuration, test isolated restores, and plan session/token revocation when restoring old data. An integrity check proves database consistency, not freshness, provenance or absence of malicious operator modifications. Key rotation is not a substitute for revoking compromised sessions or rotating other credentials.

Synthetic tests do not prove real provider delivery, browser/device compatibility, accessibility conformance, production resilience, recovery time or independent security review. Keep those claims separate from local verification results.

This repository follows the [core URLCode security policy](https://github.com/jimhoyd-com/urlcode/blob/main/SECURITY.md) for reporting and support baseline.
