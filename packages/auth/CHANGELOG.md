# @jimhoyd/urlcode-auth

## Unreleased

**Extension split (breaking).** Auth now `requires` `ui`, `audit` and `mail` and `uses` `abuse`; `urlcode extensions add auth` installs the required ones. There are no aliases or migrations:

- Email: every message goes through the mail extension (`MailExports`), including the ones an administrator starts. The sender callbacks (`sendEmailCode`, `notify` and the rest), `createSesSender`, `createDevelopmentSender`, `emailCopy`/`createEmailCopy` and the `@aws-sdk/client-sesv2` peer are removed; choose the transport with `mail({transport, from})` in `host.mjs` and translate messages in `mail/copy/<locale>.json`. Without a transport auth serves password sign-in only; a service with required email verification refuses to activate. New messages: `account-setup` and `impersonation-started`.
- Audit: privileged actions are written to `auth_audit_outbox` in the same transaction as the change and drained into the audit extension; at 10000 undelivered events a change answers `503 audit_backlog`. The `auth_audit` table, `auditRetention`, `onAuditPruned`, `listAudit`, the `urlcode-auth audit` command and the `auth.audit.read`/`auth.audit.export` permissions are removed (11 permissions remain); grant `audit.read`/`audit.export` instead. `doctor` reports `auditBacklog`. An existing database keeps its old `auth_audit` table untouched; export anything you need from it with the previous release.
- Abuse: budgets, challenge escalation and password backoff are reviewed YAML in `extensions.auth.config.abuse` (`client`, `signupClient`, `signupDomain`, `challengeAfter`, `passwordBackoff`), enforced through the abuse extension. `AuthOptions.abuse`, `createTurnstileChallenge` and the challenge exports moved to `@jimhoyd/urlcode-abuse`; the challenge widget is passed to the kit as an `async` script instead of a rewritten nonce.
- `AuthExports` v1 (`account(request)`, `csrf`, `urls`, `administration`) is what another extension reads with `ctx.get('auth')`. Admin no longer receives `{service, csrfKey}`. The index no longer exports `AuthHttp`, `AuthHttpError`, `hasPermission`, `jsonResponse`, `readFields`, `wantsJson`, `csrfField`, `formField`, `screenResponse`, `validateUserQuery`, `createPresentation`, `englishCatalogue`/`authCatalogue`, `authTemplates` or `AuthPrincipal`. The internal `createPresentation` wrapper and its `--auth-*` theme-variable remap are deleted: theme variables are ui's `--ui-*` names.
- Copy: the operator `presentation` option on `createAuth` is removed. Auth resolves every string through the `ui` kit, so a project overrides or translates it in `ui/copy/<locale>.json`. Screen titles are resolved from their `page.*` catalogue key rather than looked up from the English title; `page.verifyEmailChange` now reads the title that screen already showed ("Confirm new email after the 24-hour cooling period").
- CSRF: a new route key `auth: {csrf: token | origin}`. Auth's token is accepted from the `x-csrf-token` header or a `csrf` body field, so a plain HTML form POST to an `auth:` route works (#745). `csrf: origin` admits writes on same-origin provenance and the session cookie alone, for mounts that verify their own token or take JSON only.
- Requests use core's helpers and its single same-origin rule: a write with no `Origin` but `Sec-Fetch-Site: same-origin` is now admitted; a malformed session cookie reads as signed out; a repeated or oversized `Cookie` header is 400; a wrong content type is core's 415; JSON answers carry core's headers.
- Hooks: `beforeRegister`, `beforeRoleChange`, `onAccountCreated`, `onAccountStatusChanged`, `onDeletionScheduled`, `onAccountDeleted`, fired by the service for every path, the CLI included (`--project`, `--no-project-hooks`). `onSignUp` and `onDelete` are removed; admin's hooks moved here. Filters time out after 5 s; actions no longer fail the request.
- The support-session banner comes from auth's middleware on every route an auth policy guards.
- Invitations are offered only on an invite-only site with mail delivery.

Auth records the relying-party ID each new passkey is registered under and warns the operator at startup when stored passkeys cannot work under the current one (#736). Every insert path (account passkey, signup, waitlist approval) stores the ceremony's RP ID in the credential JSON (`rpId` on `StoredPasskey`/`AuthPasskey`, which `addPasskey` and the signup passkey step now accept and validate) and in a new nullable `rp_id` column; existing databases gain the column in place and their passkeys stay unrecorded. At activation, one aggregate query (`AuthService.countPasskeysByRelyingParty`) feeds core's new generic activation warning: `N passkeys were registered under a different relying-party ID ...` for recorded mismatches, and a softer warning about unrecorded passkeys only when a `--passkey-rp-id` other than the canonical host is set (they are assumed to be canonical-host passkeys). Counts only, never account, email or credential ids. Verification is unchanged.

Opt-in shared passkey relying-party domain for alias origins (#729). When the operator sets `--passkey-rp-id` (`passkeyRpId`, `URLCODE_PASSKEY_RP_ID`), core validates it and passes it to the activation as `passkeyRpId`, and auth rebinds its passkey provider with the new `withSite({rpId, origins})`: registration and authentication options carry the shared RP ID and verification accepts any site origin (canonical or alias). `PasskeyProvider` is now an explicit interface exposing `rpId`, `origins` and `withSite`; `PasskeySite` is exported. A provider without `withSite` is refused at activation when the RP ID is set. Unset, nothing changes: RP ID = canonical host, canonical origin only, so existing passkeys keep working. **Setting, changing or removing the RP ID makes passkeys registered under the previous RP ID stop working; users must re-register.** Auth did not record per-credential RP IDs at the time; see the #736 entry above for the startup warning.

Auth provides core's opaque request principal (#331, `RIM-EXT-PRINCIPAL-001`): the registration declares `providesPrincipal: true`, and `authorize()` sets the principal only on a request it allows — the signed-in user's stable id for a session-protected route (after the CSRF check on a write), or `apikey:<key id>` for a bearer route (operator-issued keys have no owning user, so the key is the principal, namespaced apart from user ids; `apiKeyPrincipalId` is exported). An owned store collection scopes its records by it. Nothing auth decides changes.

The same-origin CSRF check admits the operator's site-wide alias origins (`--alias-origin`, `aliasOrigins`) in `Origin` beside the canonical origin, using core's `isSiteOrigin`; `AuthHttp` takes the list as a new `origins` option. `Origin` is still required, and CSRF tokens, links and (unless a shared passkey RP ID is set, #729) passkeys stay bound to the canonical origin (#717).

**Default behavior change:** `urlcode extensions add` (and `init --with`) now installs only the capability; the new `--example` flag, the same for every extension, writes the sample behavior it used to write by default (#711). A blank `extensions add auth` writes the `/account/*` mount, the operator service (the documented `{member, admin}` role model with `defaultRole: member`, kept as capability configuration) and keys, and no `/private` page; `--example` adds the signed-in `/private` page. To reproduce the old result, add `--example`.

Bearer routes accept a per-credential quota, `auth: {bearer: {scopes, quota: {requests, window}}}` (#572): each API key gets `requests` per `window` seconds, counted by key id in the auth SQLite store (fixed window, durable, shared by processes on one host). The request over budget is refused with 429, `Retry-After` and `RateLimit-Policy`/`RateLimit` under the policy name `credential`, before the handler runs. `AuthService.consumeApiKeyQuota` is the service method behind it.

An API key can carry its own quota, `issueApiKey({name, scopes, quota: {requests, window}})` or `quota` in the `api-key-issue` JSON (#703). A key's own quota replaces the route's `auth.bearer.quota` for that key, on every bearer route; keys without one use the route's. Existing databases gain the columns in place and existing keys have no quota. `authenticateApiKey` and `listApiKeys` return `quota` (`null` when unset). Allowed, counted bearer responses now carry `RateLimit-Policy`/`RateLimit` under `credential` (the extension's `middleware()` hook), ahead of core throttle's `default` member when both apply.

An API key can act for a user (#732): `issueApiKey({name, scopes, quota?, userId})`, or `userId` in the `api-key-issue` JSON, links it to an existing, active account (anything else is refused with `invalid_api_key_user`). Such a key sets the request principal to the user's id instead of `apikey:<key id>`, so records it creates in an owned store collection belong to the user and survive rotating the key; it still acts only within its own scopes, not the user's roles. It authenticates only while its user is active: locking the account or starting its deletion disables it (unlocking or cancelling re-enables it), and purging the account revokes it. `authenticateApiKey` returns `userId`, `listApiKeys`/`api-key-list` return `userId` and `userDisabled`, and the `x-urlcode-context-auth-principal` header carries `userId` for a linked key. Keys without `userId` are unchanged; existing databases gain a nullable `user_id` column in place.

Lifecycle hooks (`beforeRegister`, `onSignUp`, `onDelete`) receive core's generic hook context, `{requestId, env}`, as a second argument (#678).

## 0.5.0

Align the coordinated stable release at `0.5.0` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.9

Align the coordinated stable release at `0.4.9` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.6

Align the coordinated stable release at `0.4.6` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3, 0.4.4 and 0.4.5 were prepared but never published, so npm went from 0.4.2 straight to this release. 0.4.3's candidate failed in the release container (two checks called `git ls-files` on a checkout owned by another user); 0.4.4's publisher stopped at its preflight (the peer-floor guard held core itself to a floor it cannot have); 0.4.5 stopped at the CI gate, where the slowest runner (Windows, Node 22) took over 500 ms for a pattern the guard accepts. The `v0.4.4` tag stays where it is. This release fixes all three, and lowers the input bound for schema `pattern` from 256 to 128 characters (a schema that sets `pattern` now needs `maxLength` of at most 128), which makes the worst accepted pattern about eight times cheaper. It carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.5

Align the coordinated stable release at `0.4.5` on npm’s `latest` channel. Internal peer minimums advance to this release.

Versions 0.4.3 and 0.4.4 were prepared but never published. The 0.4.3 candidate failed in the release container because two checks called `git ls-files` on a checkout owned by another user. The 0.4.4 publisher then stopped at its preflight, which held core itself to a peer floor it cannot have. Nothing was published for either version (npm went from 0.4.2 straight to this release), and the `v0.4.4` tag stays where it is. This release fixes both and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, store collection sorting and filtering, the data-bound CRUD screen, and the first store release line.

## 0.4.4

Align the coordinated stable release at `0.4.4` on npm’s `latest` channel. Internal peer minimums advance to this release.

Version 0.4.3 was prepared but never published: its candidate build failed in the release container because two checks called `git ls-files` on a checkout owned by another user, which git refuses as dubious ownership. Nothing was tagged or published for 0.4.3. This release fixes those checks and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`, on top of 0.4.2. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, the store collection sorting and filtering, the data-bound CRUD screen, and the first store extension release line.

## 0.4.3

Align the coordinated stable release at `0.4.3` on npm’s `latest` channel. Internal peer minimums advance to this release.

The auth store worker reports the last startup stage it reached, and the readiness-timeout message names it, so a slow start shows where it stalled. The auth scaffold declares what it provides and requires, so `init --with` no longer depends on argument order.

Keep published archives to built runtime files and required legal, security and usage material. Auth installations no longer pull the AWS SES SDK unless the operator selects the built-in SES sender.

## 0.4.2

Align the coordinated stable release at `0.4.2` on npm’s `latest` channel. Internal peer minimums advance to this release.

## 0.4.1

Align the coordinated stable release at `0.4.1` on npm’s `latest` channel. Internal peer minimums advance to this release.

This coordinated release moves core, UI, auth and admin from `0.4.0-alpha.3` to stable `0.4.1`. It makes the reviewed monorepo release line available through npm `latest` and keeps the four packages' peer minimums aligned.

The runtime retains its existing trust model: project functions and middleware run trusted in Node by default; routes declaring `sandbox: true` retain QuickJS/WASM isolation. The stable label is a distribution decision, not an independent security assessment or hostile multi-tenant readiness claim.

Release preparation now supports an explicit exit from alpha. Publication promotes the exact signed candidate archives, pins their manifest digest in immutable tags, checks actual npm installability, and updates the standalone starter to the published core version. Historical alpha versions and tags remain unchanged.

Breaking: the `ui` extension is now required. Every account screen renders through the `urlcode-ui` kit; the shared-primitive fallback is gone. `authExtension({ui, ...})` refuses activation when `ui` is absent or when the runtime has not activated it, naming the missing piece instead of failing per request. Declare `ui` before `auth` in `urlcode.yaml` (with its asset route) and list `ui.registration` before `authExtension` in the host: the runtime activates extensions in the order `urlcode.yaml` declares them. `@jimhoyd/urlcode-ui` was already a required peer dependency, so nothing new needs installing; what changes is that the extension must be supplied and active. `ScreenOptions.ui` is no longer optional and `screenObserver` no longer reports a render path.

Scaffolding composes the kit for you: `urlcode init --with ui,auth` and the standalone `initAuthentication` now write a project whose `urlcode.yaml` declares `ui` first and whose host passes it to `authExtension`. The scaffold refuses when `ui` is missing, or ordered after `auth`, before anything is written.

Report which startup phase an auth store worker reached when its 15-second bound elapses, and reject at once when the worker fails or exits before reporting readiness instead of waiting the bound out. The status and code are unchanged; the detail is attached as the error's cause for operator logs and never reaches a response.

`urlcode-auth init` now writes a `package.json` that pins this package and each declared peer at the exact version installed beside it, instead of a manifest with no dependencies at all; `initAuthentication` returns those pins and names any peer it could not resolve. Nothing is installed: running `npm install` in the generated directory to produce a lockfile stays the operator's explicit step, and no upgrade command exists.

<!-- local-links: historical-file -->

## 0.4.0-alpha.3

- Carry forward deterministic SQLite worker termination on rejected initialization, preserving the original configuration error and avoiding Windows file-handle races.
- Refresh lifecycle hook entry modules on each activation; changes to imported hook dependencies still require a process restart.
- Align the release with core/UI/admin at `0.4.0-alpha.3` and require the coordinated core/UI peer floors.

## 0.1.0-alpha.6

### Patch Changes

- No change to the published package.
  
  `0.1.0-alpha.5` was tagged at a commit whose `prepare-extension-release.sh`
  never built core or ui before typechecking auth against them, so the release
  failed at preparation and published nothing. Release tags are immutable and
  GitHub runs a workflow from the commit its tag points at, so the fix needs a
  new tag on a new commit rather than a retag.
- 174319a: Fix backup and restore on Windows by flushing the snapshot through a writable handle. Preserve POSIX directory flushing and document the Windows directory-entry durability limitation.

## 0.1.0-alpha.5

### Patch Changes

- No change to the published package.
  
  `0.1.0-alpha.4` was versioned and tagged but never published. Its tag was
  created before the peer-floor gate was fixed, and GitHub runs a workflow from
  the commit the tag points at, so re-running that release would have re-executed
  the broken gate. Moving a tag onto a later commit is worse than spending a
  version number, so the version moves instead and the inert `0.1.0-alpha.4` tag
  is left pointing at a commit that never shipped.
  
  `@jimhoyd/urlcode-ui@0.1.0-alpha.6` and `@jimhoyd/urlcode-admin@0.1.0-alpha.4`
  published normally; this only affects auth.

## 0.1.0-alpha.4

### Patch Changes

- Move into the core repository as `packages/auth`.
  
  No API change. The package's source moved from `jimhoyd-com/urlcode-auth` into
  `jimhoyd-com/urlcode` as a workspace package, and its peer pinning went with
  it: `peers.json` and its test are gone, because a workspace package and its
  siblings are the same commit by construction and cannot drift apart.
  
  - Two stale trust-model paragraphs in `docs/SPIKE-AUTH.md` now carry the
    machine-readable `trust-model-prose: historical` marker. Both already had
    human-written corrections beside them; core's enforcing check could not see
    those, and now reaches this package's prose.
  - Ten lint errors fixed, since core's `eslint .` now covers this package.
    Three empty `catch` blocks say what they swallow; four redundant escapes were
    removed from an email local-part pattern and a hostname pattern, both
    verified behaviour-identical against 400k generated inputs plus an exhaustive
    sweep of every character below U+2000.
