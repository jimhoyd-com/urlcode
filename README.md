# URLCode admin

An optional administration extension backed by URLCode auth's service API. It supplies permission-gated pages for accounts, roles, sessions, audit records, registration approvals, administrative cases and explicit support impersonation. It does not replace URLCode's private runtime management endpoints or edit project YAML.

This is an actively reviewed Node/SQLite implementation. Still outstanding: live operator runtime/provider/sender observations feeding the health adapter, a full accessibility and broader browser/device/deployment assessment, and refreshed package/CI evidence whenever code or dependency pins change. Local tests are not independent security review, real-provider deployment evidence or an accessibility certification. See [SECURITY.md](SECURITY.md).

## Build from reviewed local repositories

These packages are private and unpublished. The core runtime must include the reviewed generic extension contract from [core PR #59](https://github.com/jimhoyd-com/urlcode/pull/59) or an approved successor; the version number `0.3.0` alone is insufficient. Use an exact reviewed core commit and clean committed source trees.

```sh
node scripts/pack-sources.mjs \
  --core /absolute/source/urlcode \
  --auth /absolute/source/urlcode-auth \
  --ui /absolute/source/urlcode-ui \
  --admin /absolute/source/urlcode-admin \
  --out /absolute/new-private-package-directory
```

`--core-revision` defaults to the `urlcode` entry of [`peers.json`](peers.json), the single record of the exact core/auth/UI revisions verified with this checkout (CI and [ACCEPTANCE.md](ACCEPTANCE.md) read the same file); pass it explicitly to pack against another reviewed commit. The helper runs lockfile installation without lifecycle scripts, installs unpublished peers from local tarballs, typechecks/builds, packs and records commit/integrity metadata. Nothing is published. `--offline` requires an existing dependency cache; `--skip-install` reuses third-party dependencies. Neither bypasses the reviewed revision/clean-tree requirement. Run each repository's full `npm run verify` separately.

Install the resulting core, UI, auth and admin tarballs together in your operator directory, using filenames recorded in `source-manifest.json`. Follow auth's scaffold/bootstrap procedure first, or run `urlcode-admin init --directory NEW_DIRECTORY`, which wires both auth and admin into the generated host and route project; review the result before activation.

## Wiring

Declare the additional logical extension and its exclusive mount:

```yaml
extensions:
  admin:
    version: '1'
    config: {}
routes:
  /admin/*:
    extension: admin
    methods: [GET, HEAD, POST]
```

Merge these entries into the existing versioned auth project, then review and update the static project revision pin. In the trusted external host:

```js
import {authExtension} from '@jimhoyd/urlcode-auth';
import {adminExtension} from '@jimhoyd/urlcode-admin';

// service, csrfKey and reviewed projectSha256 are operator-owned values.
export default {
  extensions: [
    authExtension({service, csrfKey, projectSha256}),
    adminExtension({service, csrfKey, projectSha256, authMount: '/account'}),
  ],
  async close() { await service.close(); },
};
```

The snippet is an integration fragment; use the auth scaffold's private key/service setup and required HTTPS origin rather than inventing credentials. Use the same CSRF key and shared service. No auth package is loaded from application YAML. Runtime activation uses the explicit external host and matching canonical `--origin`.

Administrative actions authenticate internally even without an extra route policy. Missing sessions or administrative permissions receive 404 at the console gate. Use operator role declarations with the actual permissions exported by this implementation: `auth.users.read`, `auth.users.reveal`, `auth.users.export`, `auth.users.manage`, `auth.users.create`, `auth.sessions.manage`, `auth.roles.read`, `auth.audit.read`, `auth.cases.read`, `auth.cases.manage`, and `auth.users.impersonate`. `*` grants full operator-defined administrator permissions. Do not copy the proposal's separate `admin.*` permission names and expect them to work automatically.

## Operating the console

Bootstrap the first administrator through auth's operator CLI using JSON stdin. Writes require recent authentication and a reason; role/status/session changes run through the auth service's transactional authority checks. Roles themselves remain operator configuration. Masked lists, pagination, permission-filtered navigation and audit records help limit routine exposure.

Cases currently model bounded, two-person approval of specific administrative changes with target-version checks. They are not a complete lost-everything identity-verification process. Establish an operator evidence procedure before using factor-reset cases. The console does not supply all proposed notes, close/reject, requester evidence or reporting workflows.

Impersonation requires explicit service opt-in, a dedicated permission and a `notifyImpersonation` callback. If the required notification fails, the issued session is revoked before returning it. Impersonation expires and cannot perform fresh account-security/admin changes. The account page shows a warning; arbitrary guest application pages do not automatically show a banner. Ending impersonation requires signing back in as the operator.

Optional presentation and invitation/notification callbacks are operator-owned integrations. No real SES, Google or Apple account is provisioned by this package. Keep keys and database backups outside the application project, retain matching configuration, and close the shared service only once after both extensions stop.

Apache-2.0. The package remains private; packing does not publish it.

## New local installation

After installing the reviewed local packages, run `urlcode-admin init --directory /absolute/new/site`. It creates a private operator host and database key directory outside the route project, with registration off and auth/admin mounts configured. Follow the generated README to bootstrap the first administrator, configure HTTPS and approve the project revision. This does not deploy or send mail.

## Programmatic scaffold

`scaffold(request)` is the contract core's `urlcode init --with auth,admin` calls on each installed `@jimhoyd/urlcode-<name>` package; auth and admin export the same shape. It describes admin's contribution and never writes:

```ts
import {scaffold} from '@jimhoyd/urlcode-admin';
const result = await scaffold({directory, project, hostFile, names: ['auth', 'admin']});
// result.extensions -> {admin: {version: '1', config: {}}}
// result.routes     -> {'/admin/*': {extension: 'admin', methods: ['GET', 'HEAD', 'POST']}}
// result.hostImports, result.hostSetup, result.hostEntries -> lines for host.mjs
// result.files -> [] ; result.readme -> "## Administration" section ; result.nextSteps
```

Admin contributes the `admin` extension block, the `/admin/*` mount, one `adminExtension({service, csrfKey, projectSha256, authMount: '/account'})` host entry and a README section. It writes no key files and defines no environment: the `service`, `csrfKey` and `projectSha256` identifiers its host entry references are defined by auth's host setup, so `names` must include `auth` (the call refuses otherwise). The caller merges each result's `extensions` and `routes` into one `urlcode.yaml`, concatenates host imports, setup and entries in order, and appends the README sections. `urlcode-admin init` composes this result with auth's initializer and produces the same files it always did. Types `ScaffoldRequest`, `ScaffoldFile` and `ScaffoldResult` are exported.

## Private dependency CI

Verification runs automatically for pull requests and pushes to main, and can also be dispatched manually. It checks out the exact core/auth/UI revisions recorded in [`peers.json`](peers.json) (a single workflow step reads the file and later steps use its outputs) and runs Node 22/24/26. `npm test` first runs `scripts/check-sqlite.mjs`, which exits with the SQLite requirement and the bundled version named when the Node release lacks a patched SQLite (3.51.3+, or 3.50.7+/3.44.6+ within those lines), the same rule auth's store enforces at runtime. The approved read-only credentials are `URLCODE_AUTH_READ_TOKEN` and `URLCODE_UI_READ_TOKEN`; deploy keys remain disabled by repository policy. Credentials are not persisted by checkout. Fork pull requests do not receive repository secrets and cannot complete private dependency checkout; they require a reviewed maintainer branch. Do not switch to `pull_request_target` to run untrusted changes with secrets, reuse broad personal tokens, or weaken repository policy. Local full verification and source-package smoke tests remain usable without CI credentials.

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
  auth: {service, csrfKey, projectSha256},
  runtime: {origin: 'https://accounts.example.com'},
  admin: {notifyImpersonation},
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

Install the reviewed `@jimhoyd/urlcode-ui` archive alongside core before installing
this package. The UI peer owns document layout, semantic fields, escaping, themes
and the locale engine; authentication/administration behavior remains here.
`scripts/pack-sources.mjs` now requires `--ui /absolute/path/to/urlcode-ui` and
builds the UI archive before its consumers. Core can use UI without auth/admin.
Cross-private-repository CI needs the narrow `URLCODE_UI_READ_TOKEN`; no package
publication or broad credential is used as a workaround.

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

`adminExtension` takes an optional `ui`, the object `createUiExtension` returns.
Declare `ui` first in the host file so the runtime activates it before auth and
admin; admin reads `ui.kit` per request and never captures it at activation.

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

With `ui`, screens render through `ui.kit`: the project's theme, layout, hashed
stylesheet and copy apply, the console navigation becomes the layout's primary
navigation and account menu, a project file `ui/templates/admin/<screen>.html`
shadows the shipped template, and `urlcode-ui doctor` reports every `admin/*`
template behind its view model. Copy then resolves through the kit's presentation
composed with the admin catalogue: register `authCatalogue` in `sources` (the kit's
catalogue holds at most 512 keys, so it cannot also take `adminCatalogue`; admin
composes its own copy on top) and omit `presentation`. If both are given,
`presentation` wins.

Without `ui`, nothing changes: screens render the same templates through the shared
primitives inside the console shell, with `presentation` (or the bundled English
catalogue). The `presentation` option remains the fallback; core plans to retire it
one minor version after the kit path ships.

Use `createAdminPresentation` when translating console-specific copy without the
kit. It composes bounded auth and admin catalogues while keeping account workflows
out of URLCode UI. Existing `presentation` instances remain supported; untranslated
new messages fall back to English.

```js
import {createAdminPresentation} from '@jimhoyd/urlcode-admin';
const presentation = createAdminPresentation({
  catalogues: {fr: {'adminUi.noSessions': 'Aucune session active.'}},
});
// Pass presentation to adminExtension, or the admin options of createAdministrationRuntime.
```

See [UX-REVIEW.md](./UX-REVIEW.md) for reviewed screens, changes and validation limits.
