# URLCode auth

An optional, operator-installed authentication extension for URLCode. This repository contains the Node/SQLite implementation: password and passkey authentication, OpenID Connect, email codes, TOTP, recovery codes, versioned registration profiles, account lifecycle operations, administrative service operations and trusted HTML pages.

[![CI](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

The implementation is under active review. Local tests and builds are evidence of those checks, not an independent security assessment, production deployment, provider certification or recovery/soak result. See [SECURITY.md](SECURITY.md) for the trust boundary and [the first-release coverage review](docs/SPIKE-AUTH.md) for the proposal; the proposal is not a list of completed features.

## Install

New projects install auth from an immutable, attested executable bundle. Install
core from npm and use the supported bundle release recorded in [package and
channel alignment](../../docs/VERSION-ALIGNMENT.md).

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with ui,auth
```

Without `--bundle-release`, `init` uses `extension-bundles@v<core>` for the
installed core version; pass `--bundle-release extension-bundles@vX.Y.Z` only
to pin a different immutable release.

`urlcode init --with ui,auth` is core's
layered scaffold (auth renders through the ui kit, so `ui` must be named first:
the runtime activates extensions in the order the project declares them, and
auth's scaffold refuses any other order). It writes `app/urlcode.yaml`, external
`host.mjs` and `operator-service.mjs`, a private `data/` directory and
independent encryption/CSRF keys, and refuses an existing destination. Its
README gives the exact next steps.

Stable publication does not establish production readiness: independent
security review, accessibility assessment, broader browser/device WebAuthn
coverage and deployment/soak/recovery exercises remain pending (see
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)). Prerelease versions may
change public exports, configuration keys and the SQLite schema without a
migration path; do not run the `alpha` channel on production accounts.

Use a current supported Node release with a patched SQLite build. The actual runtime requirement is a Node build whose bundled SQLite (`process.versions.sqlite`) is 3.51.3 or newer, or a patched 3.50.7+ / 3.44.6+ branch release; `engines.node` alone does not encode this, and the service (`src/auth-store.ts`) refuses other builds with `patched_sqlite_required` even when the package's minimum Node version is satisfied.

Every bundle archive and its catalog are attested from the immutable tagged
commit; the CLI verifies them before loading a locked extension.

## Install from reviewed source

Operators who pin exact reviewed commits rather than registry versions can build the same packages locally. A registry version alone does not establish that a revision was reviewed: this implementation requires the core extension contract introduced by [core PR #59](https://github.com/jimhoyd-com/urlcode/pull/59). Use its reviewed implementation or a reviewed successor containing it, pinned to an exact commit. Do not infer approval from the current branch name.

This package also depends on the shared `@jimhoyd/urlcode-ui` peer, which owns document layout, semantic fields, escaping, themes and the locale engine; authentication/administration behavior remains here. Core can use UI without auth/admin. Both peers are siblings in this repository, so CI builds them from the same commit — there is no peer checkout, no `peers.json` and no read token; the release workflow resolves the published versions from the registry instead, to prove the declared ranges are satisfiable.

One lockfile governs the workspace. The source packaging helper installs dependencies with lifecycle scripts disabled, builds the reviewed packages in dependency order (core, then UI, then their consumers) and writes package integrity metadata. It does not publish. The tree must be committed and clean, and it re-checks that after every build and pack. `--revision` and `--out` are required; `--revision` is exact and has no default, because the reviewed commit is the thing being asserted:

```sh
node scripts/pack-sources.mjs \
  --revision REVIEWED_40_CHARACTER_COMMIT_SHA \
  --out /absolute/new-private-package-directory
```

One commit identifies every package: core, ui, auth and admin are built from
the same reviewed revision of this repository. The script refuses to run if the
checkout is not at that exact commit or has uncommitted changes, and re-checks
both after each build and pack.

Omit `--admin` for auth only. `--offline` forbids network package resolution and requires a populated dependency cache. `--skip-install` reuses installed third-party dependencies; local peer tarballs are still installed. The script does not alter dependency manifests or lockfiles. Run `npm run verify` for each workspace package; source packaging runs typecheck/build, not the HTTP suite.

For reviewed-source development, install all required local tarballs together
(core, UI and auth; admin if built) in an operator-owned directory with a
private `package.json`. For a normal new project, use the signed bundle flow
above instead. For example, after checking the manifest:

```sh
npm install /absolute/packages/jimhoyd-urlcode-X.Y.Z.tgz /absolute/packages/jimhoyd-urlcode-ui-X.Y.Z.tgz /absolute/packages/jimhoyd-urlcode-auth-X.Y.Z.tgz
npx urlcode-auth init --directory /absolute/new-account-site
```

Tarball names and versions must match the generated manifest. Install the same reviewed local tarballs inside the generated directory so its host modules resolve them.

## Programmatic scaffold

`scaffold({directory, project, hostFile, names})` returns the auth pieces of a layered project (YAML fragments, host imports and entries, private files with in-memory key material, a README section and next steps) without writing anything; `initAuthentication` is assembled from it. Core's `urlcode init --with ui,auth` calls this export and merges it with other extensions; it refuses a request whose `names` omit `ui` or place it after `auth`.
Exported types: `ScaffoldRequest`, `ScaffoldResult`, `ScaffoldFile`.

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

The external host creates an AuthService and supplies `authExtension({service, csrfKey, projectSha256})`. The generated host requires a canonical HTTPS `AUTH_ORIGIN` and a static `PROJECT_SHA256` copied after review. Inspecting a revision with `inspectExtensionRevision(project)` grants nothing; never compute and automatically approve the current project during activation. The runtime receives the same origin through `--origin` and loads the absolute external host with `--host-file`. Guest/application code never chooses the module, database path, keys, sender credentials or grants.

Registration starts off. Bootstrap the first administrator through `urlcode-auth bootstrap --operator-file /absolute/operator-service.mjs`, supplying `{email,password}` as bounded JSON on stdin. Never place passwords in command arguments or source files. The command returns account metadata, not the session token. A role/default-role configuration change is a reviewed operator change, not an administration-page edit.

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

`createPresentation` supplies configured locale catalogues, plural rules, RTL, and validated theme variables/local logo paths. Messages are plain text and escaped by renderers. It does not load executable project templates or arbitrary HTML/CSS. Translation coverage and accessibility require review; the helper does not establish WCAG conformance. Registration metadata is descriptive data and never authorization authority. Private metadata is excluded from public projections; public and unsafe fields remain untrusted.

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
`error="insufficient_scope"` naming the missing scopes. **The verified key's
id/name/scopes are not currently exposed to the protected route's own
`function`/`middleware` context** — the gate gives only the allow/deny
decision, not the principal, because no extension has a way to hand data
forward into that context today. Tracked as
[urlcode#618](https://github.com/jimhoyd-com/urlcode/issues/618); a route that
needs to know *which* key authenticated cannot yet do so from inside its own
handler.

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
| `init` | `--directory NEW_DIRECTORY` | Scaffold a new account site; refuses an existing destination |
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
| `api-key-issue` | `--operator-file`, JSON `{name,scopes,expiresInMs?}` on stdin | Issue a bearer/API key; returns the raw key once, never stored |
| `api-key-list` | `--operator-file` | List issued keys (id/name/scopes/created/expires/revoked/lastUsed; never the raw key or its hash) |
| `api-key-revoke` | `--operator-file`, JSON `{id}` on stdin | Revoke a key by its id |
| `validate` | `--operator-file` | Offline validation of the loaded service's configuration |
| `auth-baseline` | none (refuses `--operator-file`) | Offline synthetic checks against a temporary runtime |
| `verify-deployment` | JSON `{origin,authMount,allowDevelopment?,allowTurnstile?}` on stdin | Anonymous header/cookie checks of a deployed site |
| `backup` | JSON `{database,destination,projectRoot}` on stdin | Online SQLite backup to a new private path |
| `restore` | JSON `{backup,destination,projectRoot}` on stdin | Restore a backup to a new private path |

`--operator-file` is an absolute path to a module that default-exports an `AuthService`.

Backup/restore accepts JSON paths on stdin. `createBackup({database,destination,projectRoot})` uses SQLite's online backup API, including committed WAL pages, with a bounded worker and integrity checks. `restoreBackup({backup,destination,projectRoot})` restores to a **new** path. Both require private operator paths outside the project and refuse overwrite. Never copy only a live `.sqlite` file and assume its WAL is included. See [backup and restore platform guarantees](../../docs/AUTH-BACKUP.md), including Windows ACL and directory durability limits.

Back up encryption keys, CSRF keys and reviewed static configuration separately. Database snapshots contain sensitive account/audit data and password hashes, but do not export key files. Restoring historical data also restores historical sessions/tokens and revocation state: plan revocation and recovery before reopening traffic. Rotate keys by adding a new active key, retaining decryption keys while bounded migration reports remaining records, then remove old keys only after completion and backup verification. Old writers fail closed after activation switches. Keep a tested isolated restore procedure.

The host owns the shared service and sender lifecycle. Close them once after all extension runtimes stop. Scheduled purge/sweep operation and backups are operator responsibilities; opportunistic cleanup is not a retention policy.

Apache-2.0. The protected `extension-bundles.yml` workflow publishes immutable,
attested executable bundle releases; `verify.yml` publishes nothing.

## Operator presets and enrollment

`createAuthPreset({preset: 'standard', origin, rpName, sender?})` supplies passkeys, standard session limits and seven-day deletion grace. Without a sender it returns an explicit notice that email flows are unavailable. TOTP and recovery are service capabilities; remembered devices can optionally exempt ordinary MFA, but never grant fresh step-up authority.

`createAuthPreset({preset: 'hardened', origin, rpName, sender, checkPassword: createPasswordBreachChecker()})` requires both adapters and supplies mandatory email verification followed by TOTP enrollment, shorter sessions and 30-day deletion grace. Spread `preset.service` into `createAuthService` and `preset.extension` into `authExtension`, together with your operator paths, keys and static project pin. Choosing the online breach checker makes password creation/reset depend on that external service; inject an approved local checker if needed. Deliberate overrides change the effective policy and should be reviewed.

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

`authExtension` requires `ui`, the object `createUiExtension` returns: the kit is the only render path. Declare `ui` before `auth` in `urlcode.yaml` and list `ui.registration` before `authExtension` in the host — the runtime activates extensions in the order `urlcode.yaml` declares them, and auth refuses activation when `ui` is missing or not yet activated. Auth reads `ui.kit` per request and never captures it at activation. `@jimhoyd/urlcode-ui` is already a required peer dependency, so this adds nothing to install.

```js
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { authExtension, authCatalogue, authUiTemplates } from '@jimhoyd/urlcode-auth';
const ui = createUiExtension({ projectSha256, projectRoot: '/absolute/site', sources: [authCatalogue], extensions: [authUiTemplates] });
export default { extensions: [ui.registration, authExtension({ service, csrfKey, projectSha256, ui })] };
```

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

Auth pages use `Referrer-Policy: strict-origin`: path/query credentials are never sent as referrers, while browsers retain the Origin header needed for no-JavaScript POST forms. Null or foreign Origin headers remain rejected. Live pagination cursors use a process-local HMAC key; restart the search after a worker restart or changed boundary.
