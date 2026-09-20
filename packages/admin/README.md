# URLCode admin

An optional administration extension backed by URLCode auth's service API. It supplies permission-gated pages for accounts, roles, sessions, audit records, registration approvals, administrative cases and explicit support impersonation. It does not replace URLCode's private runtime management endpoints or edit project YAML.

[![CI](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

This is an actively reviewed Node/SQLite implementation. Still outstanding: live operator runtime/provider/sender observations feeding the health adapter, a full accessibility and broader browser/device/deployment assessment, and refreshed package/CI evidence whenever code or dependency pins change. Local tests are not independent security review, real-provider deployment evidence or an accessibility certification. See [SECURITY.md](SECURITY.md).

## Install

```sh
npm install @jimhoyd/urlcode @jimhoyd/urlcode-ui @jimhoyd/urlcode-auth @jimhoyd/urlcode-admin
npx urlcode init my-site --with ui,auth,admin
```

`@jimhoyd/urlcode-admin` is published to npm as an alpha. Alpha releases can change exported names, the console's routes and the scaffold output between versions without a deprecation period; pin exact versions in an operator directory and read the release notes before upgrading. The package declares its peers — `@jimhoyd/urlcode`, `@jimhoyd/urlcode-auth` and `@jimhoyd/urlcode-ui` — by version range in `package.json`, so install all four together and read the current ranges there rather than from this page; npm resolves them from the registry. Every release is built by the tag-driven [release workflow](../../.github/workflows/release-admin.yml), signed with a GitHub attestation and published through npm trusted publishing, so `gh attestation verify jimhoyd-urlcode-admin-<version>.tgz --repo jimhoyd-com/urlcode` and `npm audit signatures` can check what you downloaded. Publishing is still not a security review, real-provider deployment evidence or an accessibility certification.

## Build from reviewed local repositories

The published packages are the supported path; building from source remains available for deployments that must review and pin exact commits rather than registry versions. The core runtime must include the reviewed generic extension contract from [core PR #59](https://github.com/jimhoyd-com/urlcode/pull/59) or an approved successor; the version number `0.3.0` alone is insufficient. Use an exact reviewed core commit and clean committed source trees.

```sh
node scripts/pack-sources.mjs \
  --revision REVIEWED_40_CHARACTER_COMMIT_SHA \
  --out /absolute/new-private-package-directory
```

One commit identifies every package: core, ui, auth and admin are built from
the same reviewed revision of this repository. The script refuses to run if the
checkout is not at that exact commit or has uncommitted changes, and re-checks
both after each build and pack.

`--revision` is required and exact — one commit identifies core, UI, auth and admin, because they are siblings in this repository. The helper runs lockfile installation without lifecycle scripts, typechecks, builds and packs each package in dependency order, and records integrity metadata. Peers are never resolved from the registry: the workspace resolves them to this tree, which `scripts/check-workspace-links.ts` enforces. Nothing is published. `--offline` requires an existing dependency cache; `--skip-install` reuses third-party dependencies. Neither bypasses the reviewed-revision or clean-tree requirement. Run the root `npm run verify` for the full suite.

Install the resulting core, UI, auth and admin tarballs together in your operator directory, using filenames recorded in `source-manifest.json`. Follow auth's scaffold/bootstrap procedure first, or run `urlcode-admin init --directory NEW_DIRECTORY`, which wires both auth and admin into the generated host and route project; review the result before activation.

## Wiring

Declare the ui extension the console renders through, the admin extension and
their exclusive mounts. `ui` must come before `admin`: the runtime activates
extensions in declaration order, and admin's activation refuses if the kit is not
already active.

```yaml
extensions:
  ui:
    version: '1'
    config: {}
  admin:
    version: '1'
    config: {}
routes:
  /assets/ui/*:
    extension: ui
    methods: [GET, HEAD]
  /admin/*:
    extension: admin
    methods: [GET, HEAD, POST]
```

Merge these entries into the existing versioned auth project, then review and update the static project revision pin. In the trusted external host:

```js
import {createUiExtension} from '@jimhoyd/urlcode-ui/host';
import {authExtension, authCatalogue, authUiTemplates} from '@jimhoyd/urlcode-auth';
import {adminExtension, adminUiTemplates} from '@jimhoyd/urlcode-admin';

// service, csrfKey and reviewed projectSha256 are operator-owned values.
const ui = createUiExtension({projectSha256, projectRoot: '/absolute/site', sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]});
export default {
  extensions: [
    ui.registration,
    authExtension({service, csrfKey, projectSha256, ui}),
    adminExtension({service, csrfKey, projectSha256, authMount: '/account', ui}),
  ],
  async close() { await service.close(); },
};
```

The snippet is an integration fragment; use the auth scaffold's private key/service setup and required HTTPS origin rather than inventing credentials. Use the same CSRF key and shared service. No auth package is loaded from application YAML. Runtime activation uses the explicit external host and matching canonical `--origin`.

Administrative actions authenticate internally even without an extra route policy. Missing sessions or administrative permissions receive 404 at the console gate. Use operator role declarations with the actual permissions exported by this implementation: `auth.users.read`, `auth.users.reveal`, `auth.users.export`, `auth.users.manage`, `auth.users.create`, `auth.sessions.manage`, `auth.roles.read`, `auth.audit.read`, `auth.cases.read`, `auth.cases.manage`, and `auth.users.impersonate`. `*` grants full operator-defined administrator permissions. Do not copy the proposal's separate `admin.*` permission names and expect them to work automatically.

## Project-level lifecycle hooks

A project can name its own function to run at three admin lifecycle points, using the same `hooks` shape core documents for extensions generally (`docs/EXTENSIONS.md`, "Project-level lifecycle hooks", in [`urlcode`](https://github.com/jimhoyd-com/urlcode)) — a bare source path (default export), or an explicit `{source, export}`, resolved relative to the project root:

```yaml
extensions:
  admin:
    version: '1'
    config:
      hooks:
        beforeRoleChange:
          source: ./hooks/role-change.mjs
        onRegistrationApproved:
          source: ./hooks/registration-approved.mjs
          export: onApproved
        onAccountStatusChanged: ./hooks/account-status.mjs
```

| Hook | Fires | Input | Verdict |
|---|---|---|---|
| `beforeRoleChange` | Before an administrator's role change is applied (`/users/roles`) | `{accountId, currentRoles, requestedRoles, actorId, reason}` | `{allow: boolean, reason?: string}` — `allow: false` blocks the change before it reaches the auth service, and the request fails with 403 |
| `onRegistrationApproved` | After a waitlisted registration request is approved (`/registrations/approve`) | `{requestId, accountId, email, actorId, reason}` | none (side effect only) |
| `onAccountStatusChanged` | After an account is locked or unlocked (`/users/status`) | `{accountId, status: 'active' \| 'locked', actorId, reason}` | none (side effect only) |

**Trust model: no special case.** These hooks are first-party project code and run trusted, in-process, exactly like the general trusted-by-default rule for `function`/`middleware` routes ([SPIKE-DEFAULT-TRUST-MODEL.md](../../docs/SPIKE-DEFAULT-TRUST-MODEL.md)). This package does not implement sandboxed hook execution yet. Core exports the isolate — `SandboxPool` from `@jimhoyd/urlcode/sandbox`, the engine a sandboxed route uses ([extensions](../../docs/EXTENSIONS.md)) — but this package does not route a hook invocation through it, so the opt-in does not exist here. A hook that declares `sandbox: true` is rejected explicitly, during activation, with an error naming the hook — never silently run trusted and never ignored.

Each activation re-reads the hook's **entry** module from disk, so editing a hook file and re-activating (a dev reload) takes effect without restarting the process. Only the entry module is refreshed: modules the hook itself imports stay on Node's module cache for the life of the process, so a change to a hook's own dependency still needs a restart.

A missing hook module, or a named export that is not a function, also fails activation (not the first request that would have used it). Registration approval, role assignment and lock/unlock cover the lifecycle points with existing, unambiguous admin actions today; registration rejection, session revocation, impersonation start/end and bulk actions have no hook yet. <!-- local-links: historical --> That follow-up was filed as `jimhoyd-com/urlcode-admin#32` before the monorepo migration and did not survive the repository's retirement; refile it against [this repository](https://github.com/jimhoyd-com/urlcode/issues) if you need it tracked.

## Operating the console

Bootstrap the first administrator through auth's operator CLI using JSON stdin. Writes require recent authentication and a reason; role/status/session changes run through the auth service's transactional authority checks. Roles themselves remain operator configuration. Masked lists, pagination, permission-filtered navigation and audit records help limit routine exposure.

Cases currently model bounded, two-person approval of specific administrative changes with target-version checks. They are not a complete lost-everything identity-verification process. Establish an operator evidence procedure before using factor-reset cases. The console does not supply all proposed notes, close/reject, requester evidence or reporting workflows.

Impersonation requires explicit service opt-in, a dedicated permission and a `notifyImpersonation` callback. If the required notification fails, the issued session is revoked before returning it. Impersonation expires and cannot perform fresh account-security/admin changes. The account page shows a warning; arbitrary guest application pages do not automatically show a banner. Ending impersonation requires signing back in as the operator.

Optional presentation and invitation/notification callbacks are operator-owned integrations. No real SES, Google or Apple account is provisioned by this package. Keep keys and database backups outside the application project, retain matching configuration, and close the shared service only once after both extensions stop.

Apache-2.0. `scripts/pack-sources.mjs` only packs; publication happens exclusively through the tag-driven release workflow.

## New local installation

After installing the packages (from npm or the reviewed local tarballs), run `urlcode-admin init --directory /absolute/new/site`. It creates a private operator host and database key directory outside the route project, with registration off and auth/admin mounts configured. Follow the generated README to bootstrap the first administrator, configure HTTPS and approve the project revision. This does not deploy or send mail.

## Programmatic scaffold

`scaffold(request)` is the contract core's `urlcode init --with ui,auth,admin` calls on each installed `@jimhoyd/urlcode-<name>` package; auth and admin export the same shape. It describes admin's contribution and never writes:

```ts
import {scaffold} from '@jimhoyd/urlcode-admin';
const result = await scaffold({directory, project, hostFile, names: ['auth', 'admin']});
// result.extensions -> {admin: {version: '1', config: {}}}
// result.routes     -> {'/admin/*': {extension: 'admin', methods: ['GET', 'HEAD', 'POST']}}
// result.hostImports, result.hostSetup, result.hostEntries -> lines for host.mjs
// result.files -> [] ; result.readme -> "## Administration" section ; result.nextSteps
```

Admin contributes the `admin` extension block, the `/admin/*` mount, one `adminExtension({service, csrfKey, projectSha256, authMount: '/account', ui})` host entry and a README section. `names` must include `ui` **before** `admin` — the console renders only through the kit and the runtime activates extensions in `urlcode.yaml` order — and the call refuses otherwise, before anything is written. It writes no key files and defines no environment: the `service`, `csrfKey` and `projectSha256` identifiers its host entry references are defined by auth's host setup, so `names` must include `auth` (the call refuses otherwise). The caller merges each result's `extensions` and `routes` into one `urlcode.yaml`, concatenates host imports, setup and entries in order, and appends the README sections. `urlcode-admin init` composes this result with auth's initializer and produces the same files it always did. Types `ScaffoldRequest`, `ScaffoldFile` and `ScaffoldResult` are exported.

## Private dependency CI

Source verification runs automatically for pull requests and pushes to main, and can also be dispatched manually. It builds core, UI and auth from the same commit as this package — they are siblings in this repository — and runs Node 22/24/26 on three operating systems. `npm test` first runs `scripts/check-sqlite.mjs`, which exits with the SQLite requirement and the bundled version named when the Node release lacks a patched SQLite (3.51.3+, or 3.50.7+/3.44.6+ within those lines), the same rule auth's store enforces at runtime. No cross-repository read credentials are needed any more, and the ones that were (`URLCODE_AUTH_READ_TOKEN`, `URLCODE_UI_READ_TOKEN`) are vestigial; deploy keys remain disabled by repository policy. Credentials are not persisted by checkout. Fork pull requests do not receive repository secrets. Do not switch to `pull_request_target` to run untrusted changes with secrets, reuse broad personal tokens, or weaken repository policy. Local full verification and source-package smoke tests remain usable without CI credentials.

Releases are separate: pushing a scoped `@jimhoyd/urlcode-admin@<version>` tag whose commit is on `main` and whose version equals `package.json` runs the [release workflow](../../.github/workflows/release-admin.yml), which installs the three peers from the registry at the lower bound of each declared range, runs the same `npm run verify`, audits production dependencies, packs, attests the tarball, publishes to npm through trusted publishing when the repository variable `PUBLISH_NPM` is `true`, and creates the GitHub release with the tarball attached.

### Operator health observations

Pass `health: async ({ signal }) => snapshot` to `adminExtension` to expose the
permission-gated `/admin/health` page (`auth.health.read`). The callback reads your
trusted runtime/provider monitoring integration; the admin package does not fetch
project-supplied URLs or reuse management credentials. Its two-second deadline
aborts the signal, and at most one callback remains in flight even if an adapter
ignores cancellation. A failed or malformed observation returns an unavailable
status without exposing the original error.

```ts
health: async ({ signal }) => ({
  checkedAt: new Date().toISOString(),
  runtime: { status: 'healthy', readiness: 'healthy', version: '0.3.0', routes: 12 },
  sender: 'unknown',
  providers: [{ id: 'google', status: 'unknown' }],
  alerts: [],
})
```

The example shows the shape, not a production probe. Populate it from measured
operator observations. Status values are `healthy`, `degraded`, `unavailable`, or
`unknown`. Alert codes are `sender-failed`, `provider-expiring`,
`presentation-outdated`, and `translation-incomplete`. No provider messages,
credentials, account identifiers or arbitrary metadata are returned. The timestamp
makes the age of an observation visible; live provider checks remain a separate
operator acceptance task.

Audit readers with both `auth.audit.read` and `auth.audit.export` can download a
complete selected UTC range as JSON at `/admin/audit/export?from=...&to=...`.
Actor, subject and action filters apply to every page. The export rechecks the
session and permissions while reading and before returning the result. Requests
above 5,000 events, 4 MiB, or five seconds fail with a request to narrow the range;
they never silently return a partial file. Export timestamps are bounded at the
start of the request. Audit retention still limits the available history.

The users page supports searches by full or masked email, display name, or account ID; role, status, stored credential method (password, passkey, or external identity), mailbox verification, locale, and UTC creation/activity ranges; and ascending or descending sorting. The verified filter describes mailbox proof. Email-code availability is a deployment setting, not a stored per-user credential method. Text matching uses SQLite's built-in case handling, which is case-insensitive for ASCII letters.

Filters and sort order carry through pagination and the bounded, audited CSV page export (at most 50 accounts). Email remains masked in tables, JSON lists and CSV. Pagination is live rather than a database snapshot: if the boundary account is deleted or its sort value changes, restart the search. Cursors contain opaque identifiers and hashes, never full email or display-name sort values. Last-seen values use retained device and session activity, not a complete historical activity log; deleted or expired records can change that view.

An account's full email can be revealed only through the explicit **Reveal email address** action, with `auth.users.read` and `auth.users.reveal`, a fresh session, and a reason. The service rechecks the actor's authority and target restrictions and records an audit event. The response remains non-cacheable; routine lists and exports remain masked.

### Support-session banner integration

Before enabling impersonation, route every application response through
`withSupportBanner(runtime, { service, authMount: '/account' })` in your trusted
host. It wraps the `Runtime` returned by core `createRuntime`; your host must call
the wrapped `handle` for every route. It uses the current auth session to mark HTML
pages, links to the trusted account page to end the session, disables conditional
and compressed delivery, and forces no-store on support-session responses. It does
not send credentials or actor identity to application code.

```ts
import { createRuntime } from '@jimhoyd/urlcode';
import { withSupportBanner } from '@jimhoyd/urlcode-admin';
const runtime = withSupportBanner(
  await createRuntime(project, { origin, extensions }),
  { service, authMount: '/account' },
);
// The host routes every request through runtime.handle(request).
```

HTML that remains compressed, is invalid UTF-8 or exceeds the configured bound
(default 1 MiB) is replaced with a support-session interstitial. Non-HTML responses
carry the support marker and no-store headers. Copy can be localized with the
bounded `message`/`endLabel` options. Use trusted frontend content: arbitrary app
CSS/JavaScript can hide or alter any DOM notice. Alternate host paths, upstream
caches and the stock CLI do not install this wrapper automatically; validate the
actual host integration before turning impersonation on.

The user directory offers both current-page CSV and **all matching accounts** CSV. Complete export preserves the selected filters and sort, starts at the beginning, and buffers its result privately: more than 5,000 accounts, 4 MiB or five seconds fails with an instruction to narrow filters, without a partial download. Each included subject passes fresh actor/target export authorization and produces its own audit event; failure can leave those audit events even though no file is returned. Read/export permission is checked again before release. CSV masks email identifiers and escapes formula-like cells. This is live cursor pagination, not a database-wide snapshot: concurrent changes can require restarting and new matching rows can appear or disappear during the operation. A timed-out in-flight trusted service operation may finish auditing, but the helper schedules no further work and returns no data.

Account details expose linked overview, method administration, sessions, recovery,
activity and consent/data sections. Administrator notes are bounded, escaped
`admin.note` audit events; viewing them requires audit-read authority. Session
search filters by account, device label and UTC creation range before pagination.
Method inspection exposes recorded added/last-used timestamps, never provider
subjects or credential key material. Historical timestamps are shown as unknown.

### Integrated host runtime

For an embedded host, use `createAdministrationRuntime` instead of constructing
and wrapping the runtime separately. It mounts auth and admin using the same
operator service, CSRF key and revision pin, automatically decorates support
responses, and reports the runtime's observed health/version/route count.

```ts
import {createAdministrationRuntime} from '@jimhoyd/urlcode-admin';

const runtime = await createAdministrationRuntime(projectDirectory, {
  auth: {service, csrfKey, projectSha256, ui},
  runtime: {origin: 'https://accounts.example.com', extensions: [ui.registration]},
  admin: {ui, notifyImpersonation},
  observations: async ({signal}) => ({
    sender: 'unknown', providers: [], alerts: [],
  }),
});
// Forward every request through runtime.handle(), including public app routes.
// On shutdown: await runtime.close(); await service.close();
```

Impersonation still requires the service's explicit opt-in and a successful
notification callback. The constructor does not open a listening socket, enable
public registration, probe live providers or change project YAML. Your host owns
the auth service lifecycle; closing this runtime does not close that shared
service. Additional trusted extensions can be supplied in `runtime.extensions`.
Use `admin.authMount` when the auth mount differs from `/account`.

The health panel's readiness reflects this runtime's `healthy` state, not an
external load balancer, database recovery drill or delivery guarantee. Optional
sender/provider observations pass through the existing bounded, redacted health
adapter. When omitted those external states remain unknown. The standalone core
CLI still needs custom host integration for universal support banners; this
constructor is the supported embedded-host path.

## Shared UI dependency

Install `@jimhoyd/urlcode-ui` alongside core before installing this package (npm
does this when all four packages are installed together). The UI peer owns document layout, semantic fields, escaping, themes
and the locale engine; authentication/administration behavior remains here.
`scripts/pack-sources.mjs` builds the UI archive before its consumers, in
dependency order, from the single reviewed revision. Core can use UI without
auth/admin. There is no cross-repository source CI and no read token any more:
every peer is a sibling in this repository.

## Presentation

Every console screen is an `admin/*` template in the urlcode-ui kit language with a
declared view model (`adminTemplates`, each with a sample view; `adminUiTemplates` is
the block the `ui` extension takes): dashboard, users, user-detail, sessions, roles,
audit, registrations, cases, health, recovery-cases, account-operations, reveal and
status. The extension computes the view and the template only places it: a template
cannot change a flow, which permission gates a control, the freshness or reason gate
on a mutation, what is escaped, or the CSRF field and headers a page sends. Forms,
table rows, charts and icons arrive in the view as renderer-produced markup built by
the shared primitives.

`adminExtension` **requires** `ui`, the object `createUiExtension` returns, and
that kit must carry `adminUiTemplates`. Declare `ui` before `admin` both under
`extensions` in `urlcode.yaml` (the runtime activates extensions in declaration
order) and in the host file. Admin reads `ui.kit` per request and never captures
it at activation, but it checks at activation that the kit is there and carries
the `admin/*` templates, and refuses with a message naming what to supply. There
is no second render path: a console that cannot render through the kit does not
start.

```js
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import { authExtension, authCatalogue, authUiTemplates } from '@jimhoyd/urlcode-auth';
import { adminExtension, adminUiTemplates } from '@jimhoyd/urlcode-admin';
const ui = createUiExtension({ projectSha256, projectRoot: '/absolute/site', sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates] });
export default { extensions: [ui.registration, authExtension({ service, csrfKey, projectSha256, ui }), adminExtension({ service, csrfKey, projectSha256, ui })] };
```

```yaml
extensions:
  ui: { version: "1", config: { theme: { name: Acme }, templates: ui/templates } }
routes:
  /assets/ui/*: { extension: ui, methods: [GET, HEAD] }
```

Screens render through `ui.kit`: the project's theme, layout, hashed stylesheet
and copy apply, the kit builds the console shell (sidebar, page header and skip
target) from the navigation links and account menu admin supplies, a project file
`ui/templates/admin/<screen>.html` shadows the shipped template, and
`urlcode-ui doctor` reports every `admin/*` template behind its view model. Copy
resolves through the kit's presentation composed with the admin catalogue:
register `authCatalogue` in `sources` (the kit's catalogue holds at most 512 keys,
so it cannot also take `adminCatalogue`; admin composes its own copy on top) and
omit `presentation`. If both are given, `presentation` wins, and the document's
`lang` follows that presentation so the chrome and the body share one language.

Use `createAdminPresentation` to translate console-specific copy. It composes
bounded auth and admin catalogues while keeping account workflows out of URLCode
UI. Existing `presentation` instances remain supported; untranslated new messages
fall back to English.

```js
import {createAdminPresentation} from '@jimhoyd/urlcode-admin';
const presentation = createAdminPresentation({
  catalogues: {fr: {'adminUi.noSessions': 'Aucune session active.'}},
});
// Pass presentation to adminExtension, or the admin options of createAdministrationRuntime.
```

See [UX-REVIEW.md](./UX-REVIEW.md) for reviewed screens, changes and validation limits.
