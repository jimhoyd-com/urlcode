# URLCode auth

An optional, operator-installed authentication extension for URLCode. This repository contains the Node/SQLite implementation: password and passkey authentication, OpenID Connect, email codes, TOTP, recovery codes, versioned registration profiles, account lifecycle operations, administrative service operations and trusted HTML pages.

[![CI](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

The implementation is under active review. Local tests and builds are evidence of those checks, not an independent security assessment, production deployment, provider certification or recovery/soak result. See [SECURITY.md](SECURITY.md) for the trust boundary and [the first-release coverage review](docs/SPIKE-AUTH.md) for the proposal; the proposal is not a list of completed features.

## Install

`@jimhoyd/urlcode-auth` is published to npm as an alpha alongside its peers. Install the three packages together; the peer ranges in `package.json` require `@jimhoyd/urlcode` 0.4.0-alpha.1 or a later 0.4.x and `@jimhoyd/urlcode-ui` 0.1.0-alpha.1 or a later 0.1.x, and the release workflow builds and tests against exactly those registry versions.

```sh
npm install @jimhoyd/urlcode @jimhoyd/urlcode-ui @jimhoyd/urlcode-auth
npx urlcode init my-site --with auth
```

`urlcode init --with auth` is core's layered scaffold; `npx urlcode-auth init --directory /absolute/new-account-site` scaffolds an auth-only project. Either writes `app/urlcode.yaml`, external `host.mjs` and `operator-service.mjs`, a private `data/` directory and independent encryption/CSRF keys, and refuses an existing destination. Its README gives the exact next steps.

Alpha caveat: the source is complete for the first release and its automated checks pass, but independent security review, accessibility assessment, browser/device WebAuthn coverage and deployment/soak/recovery exercises are still pending (see [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)). Alpha versions may change public exports, configuration keys and the SQLite schema between releases without a migration path. Do not run an alpha on production accounts.

Use a current supported Node release with a patched SQLite build. The actual runtime requirement is a Node build whose bundled SQLite (`process.versions.sqlite`) is 3.51.3 or newer, or a patched 3.50.7+ / 3.44.6+ branch release; `engines.node` alone does not encode this, and the service (`src/auth-store.ts`) refuses other builds with `patched_sqlite_required` even when the package's minimum Node version is satisfied.

Every release tarball is attested from the tagged commit: `gh attestation verify jimhoyd-urlcode-auth-<version>.tgz --repo jimhoyd-com/urlcode-auth`. `npm view @jimhoyd/urlcode-auth` shows the published provenance.

## Install from reviewed source

Operators who pin exact reviewed commits rather than registry versions can build the same packages locally. A registry version alone does not establish that a revision was reviewed: this implementation requires the core extension contract introduced by [core PR #59](https://github.com/jimhoyd-com/urlcode/pull/59). Use its reviewed implementation or a reviewed successor containing it, pinned to an exact commit. Do not infer approval from the current branch name.

This package also depends on the shared `@jimhoyd/urlcode-ui` peer, which owns document layout, semantic fields, escaping, themes and the locale engine; authentication/administration behavior remains here. Core can use UI without auth/admin. Source CI (`verify.yml`) checks the peers out at the commits in [`peers.json`](peers.json) and needs the narrow `URLCODE_UI_READ_TOKEN`; the release workflow resolves them from the registry instead.

Each repository has a lockfile. The source packaging helper installs dependencies with lifecycle scripts disabled, builds the reviewed packages (core, then UI, then their consumers), installs local peer tarballs in dependency order and writes package integrity/revision metadata. It does not publish. All source trees must be committed and clean. `--core`, `--auth`, `--ui`, `--core-revision` and `--out` are required. Replace these illustrative paths with your reviewed locations. `--core-revision` defaults to the `urlcode` entry in [`peers.json`](peers.json), the single source of verified peer revisions; pass it explicitly only to override:

```sh
node scripts/pack-sources.mjs \
  --core /absolute/source/urlcode \
  --ui /absolute/source/urlcode-ui \
  --auth /absolute/source/urlcode-auth \
  --admin /absolute/source/urlcode-admin \
  --core-revision REVIEWED_40_CHARACTER_COMMIT_SHA \
  --out /absolute/new-private-package-directory
```

Omit `--admin` for auth only. `--offline` forbids network package resolution and requires a populated dependency cache. `--skip-install` reuses installed third-party dependencies; local peer tarballs are still installed. The script does not alter dependency manifests or lockfiles. Run `npm run verify` in each repository separately; source packaging runs typecheck/build, not the HTTP suite.

Install all required local tarballs together (core, UI and auth; admin if built) in an operator-owned directory with a private `package.json`. For example, after checking the manifest:

```sh
npm install /absolute/packages/jimhoyd-urlcode-0.4.0-alpha.1.tgz /absolute/packages/jimhoyd-urlcode-ui-0.1.0-alpha.1.tgz /absolute/packages/jimhoyd-urlcode-auth-0.1.0-alpha.1.tgz
npx urlcode-auth init --directory /absolute/new-account-site
```

Tarball names and versions must match the generated manifest. Install the same reviewed local tarballs inside the generated directory so its host modules resolve them.

## Programmatic scaffold

`scaffold({directory, project, hostFile, names})` returns the auth pieces of a layered project (YAML fragments, host imports and entries, private files with in-memory key material, a README section and next steps) without writing anything; `initAuthentication` is assembled from it. Core's `urlcode init --with auth` calls this export and merges it with other extensions.
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
    policies:
      extensions:
        auth: {}
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

**`sandbox: true` is not implemented for these hooks and is refused
explicitly at activation**, naming the hook: `hook <name>: sandbox: true is
not yet supported for project-level hooks, see jimhoyd-com/urlcode-auth#35`.
Core's trusted/sandboxed dispatch is wired to route dispatch, not exposed to
extensions (jimhoyd-com/urlcode#151), so this package has no way to actually
isolate a hook call yet; accepting the field and running it trusted anyway
would misrepresent the isolation a project believes it configured. Declare a
hook without `sandbox` (or with `sandbox: false`) to use it today.

## Authentication and presentation

`createAuthService` owns a private SQLite database outside the application directory. Its operations enforce authority, fresh authentication, delegation ceilings, replay protection and transaction boundaries. Callers must preserve the distinction between unrestricted operator APIs and actor-token administrative APIs. `authExtension` adds HTTP cookies, same-origin CSRF checks, bounded bodies and trusted pages.

Optional factories supply Google/Apple/generic OIDC and passkey providers. Unconfigured providers are not offered. Synthetic cryptographic fixtures do not prove real Google, Apple, authenticator or SES deployment behavior. The auth extension currently declares **Node only**; generic core extension support for AWS/Vercel does not make this SQLite service portable to their deployment environments.

`createPresentation` supplies configured locale catalogues, plural rules, RTL, and validated theme variables/local logo paths. Messages are plain text and escaped by renderers. It does not load executable project templates or arbitrary HTML/CSS. Translation coverage and accessibility require review; the helper does not establish WCAG conformance. Registration metadata is descriptive data and never authorization authority. Private metadata is excluded from public projections; public and unsafe fields remain untrusted.

## Optional breached-password screening

An operator can configure `checkPassword: createPasswordBreachChecker()` on `createAuthService`. This optional Have I Been Pwned range check sends only the SHA-1 prefix, requests padded responses, bounds concurrency/deadline/response bytes, and fails closed when the check cannot complete. It does not send the password or full hash to the service. Configuring the callback introduces an external service dependency; do not enable it silently or describe it as a complete hardened preset. Offline fixtures are not evidence of live service availability.

## Email and local development

`createSesSender({region, from, origin, authMount, credentials?})` returns a callable token sender with `sendEmailCode`, `notify` and `close`. Wire callbacks explicitly into the auth/admin factories. Production credentials come from operator configuration or the SDK credential chain; never put them in YAML. Delivery is bounded and cancellable; services cannot guarantee that an email reaches an inbox.

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
| `validate` | `--operator-file` | Offline validation of the loaded service's configuration |
| `auth-baseline` | none (refuses `--operator-file`) | Offline synthetic checks against a temporary runtime |
| `verify-deployment` | JSON `{origin,authMount,allowDevelopment?,allowTurnstile?}` on stdin | Anonymous header/cookie checks of a deployed site |
| `backup` | JSON `{database,destination,projectRoot}` on stdin | Online SQLite backup to a new private path |
| `restore` | JSON `{backup,destination,projectRoot}` on stdin | Restore a backup to a new private path |

`--operator-file` is an absolute path to a module that default-exports an `AuthService`.

Backup/restore accepts JSON paths on stdin. `createBackup({database,destination,projectRoot})` uses SQLite's online backup API, including committed WAL pages, with a bounded worker and integrity checks. `restoreBackup({backup,destination,projectRoot})` restores to a **new** path. Both require private operator paths outside the project and refuse overwrite. Never copy only a live `.sqlite` file and assume its WAL is included.

Back up encryption keys, CSRF keys and reviewed static configuration separately. Database snapshots contain sensitive account/audit data and password hashes, but do not export key files. Restoring historical data also restores historical sessions/tokens and revocation state: plan revocation and recovery before reopening traffic. Rotate keys by adding a new active key, retaining decryption keys while bounded migration reports remaining records, then remove old keys only after completion and backup verification. Old writers fail closed after activation switches. Keep a tested isolated restore procedure.

The host owns the shared service and sender lifecycle. Close them once after all extension runtimes stop. Scheduled purge/sweep operation and backups are operator responsibilities; opportunistic cleanup is not a retention policy.

Apache-2.0. `release.yml` publishes a tagged commit that is on `main` to npm through trusted publishing when the repository variable `PUBLISH_NPM` is `true`; `verify.yml` publishes nothing.

## Operator presets and enrollment

`createAuthPreset({preset: 'standard', origin, rpName, sender?})` supplies passkeys, standard session limits and seven-day deletion grace. Without a sender it returns an explicit notice that email flows are unavailable. TOTP and recovery are service capabilities; remembered devices can optionally exempt ordinary MFA, but never grant fresh step-up authority.

`createAuthPreset({preset: 'hardened', origin, rpName, sender, checkPassword: createPasswordBreachChecker()})` requires both adapters and supplies mandatory email verification followed by TOTP enrollment, shorter sessions and 30-day deletion grace. Spread `preset.service` into `createAuthService` and `preset.extension` into `authExtension`, together with your operator paths, keys and static project pin. Choosing the online breach checker makes password creation/reset depend on that external service; inject an approved local checker if needed. Deliberate overrides change the effective policy and should be reviewed.

Restricted enrollment sessions can verify their email and enroll TOTP, but cannot authorize protected application routes or administration. Required verification revokes old sessions and requires a fresh sign-in before factor enrollment. Public routes without auth policies remain public. These controls do not establish independent security certification or live provider readiness.

Configuration is database-pinned. Before changing modes, roles or security requirements, run `urlcode-auth configuration --operator-file /absolute/operator-service.mjs` and retain its revision. Review the new operator configuration and pass `approveConfigurationChangeFrom: 'the-old-64-character-revision'` on the first `createAuthService` startup. The generated operator file accepts that explicit approval through `AUTH_CONFIG_FROM`. A matching already-applied migration can be repeated safely; an unrelated pin fails.

Migration preserves accounts, enrolled credentials and history, while revoking sessions and pending authentication/registration state, closing pending cases and recording an audit entry. Existing roles must remain valid and active administration cannot be removed accidentally. Valid pending-deletion cancellation links retain only their original expiry. Old workers reject reads and writes after migration; restart every instance with the reviewed configuration, remove the approval variable, and separately review/pin the changed route project. Schedule the transition as a maintenance operation; do not edit database metadata manually.

`englishCatalogue` (also exported as `authCatalogue`) exports the semantic UI keys for catalogue authors. Translations are plain text and escaped at rendering; runtime templates never execute project markup. No complete non-English language pack is bundled. Dates, provider identifiers and user data retain their own values.

## Presentation

Every account screen is an `auth/*` template in the urlcode-ui kit language with a declared view model (`authTemplates`, each with a sample view; `authUiTemplates` is the block the `ui` extension takes). The extension computes the view and the template only places it: a template cannot change which steps a flow has, what a form validates, what is escaped, or the CSRF field and headers a page sends. Forms, fields and buttons arrive in the view as renderer-produced markup built by the shared primitives.

`authExtension` takes an optional `ui`, the object `createUiExtension` returns. Declare `ui` first in the host file so the runtime activates it before auth; auth reads `ui.kit` per request and never captures it at activation.

```js
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { authExtension, authCatalogue, authUiTemplates } from '@jimhoyd/urlcode-auth';
const ui = createUiExtension({ projectSha256, projectRoot: '/absolute/site', sources: [authCatalogue], extensions: [authUiTemplates] });
export default { extensions: [ui.registration, authExtension({ service, csrfKey, projectSha256, ui })] };
```

```yaml
extensions:
  ui: { version: "1", config: { theme: { name: Acme }, templates: ui/templates } }
routes:
  /assets/ui/*: { extension: ui, methods: [GET, HEAD] }
```

With `ui`, screens render through `ui.kit.page`: the project's theme, layout, hashed stylesheet and copy apply, a project file `ui/templates/auth/<screen>.html` shadows the shipped template, and `urlcode-ui doctor` reports every `auth/*` template behind its view model. Copy then resolves through the kit's presentation, which carries the kit catalogue, the auth catalogue and the project's `extensions.ui` copy; omit `presentation` in that case. If both are given, `presentation` wins and must register the kit catalogue for the layout's own keys.

Without `ui`, nothing changes: screens render the same templates through the shared primitives with `presentation` (or the bundled English catalogue). The `presentation` option remains the fallback; core plans to retire it one minor version after the kit path ships. The auth passkey script and the optional challenge widget are nonce-bound on both paths and the page CSP admits only that nonce (plus the challenge origin when configured).

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

`AuthOptions.abuse` enables durable progressive password backoff and trusted-client/signup-domain velocity budgets. Configure the runtime trusted-proxy boundary before enabling client limits. Optional `createTurnstileChallenge` supplies a fixed-origin widget and bounded server verification; challenge success never overrides a hard budget. Provider callbacks and existing token redemption keep their own bound proofs.

Auth pages use `Referrer-Policy: strict-origin`: path/query credentials are never sent as referrers, while browsers retain the Origin header needed for no-JavaScript POST forms. Null or foreign Origin headers remain rejected. Live pagination cursors use a process-local HMAC key; restart the search after a worker restart or changed boundary.
