# URLCode admin

An optional administration extension over URLCode auth's typed exports. It supplies permission-gated pages for accounts, roles, sessions, the audit log, registration approvals, administrative cases and explicit support impersonation. It does not replace URLCode's private runtime management endpoints or edit project YAML.

[![CI](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml/badge.svg)](https://github.com/jimhoyd-com/urlcode/actions/workflows/ci.yml)

This is an actively reviewed Node implementation. Still outstanding: live operator runtime/provider/mail observations feeding the health adapter, a full accessibility and broader browser/device/deployment assessment, and refreshed package/CI evidence whenever code or dependency pins change. Local tests are not independent security review, real-provider deployment evidence or an accessibility certification. See [SECURITY.md](SECURITY.md).

## Install

```sh
npm install @jimhoyd/urlcode
npx urlcode init my-site --with ui,auth,admin --example
# or, in an existing site:
npx urlcode extensions add admin --example
```

admin ships no example of its own: its capability is the `/admin/*` console.
`--example` here writes auth's demo (a signed-in `/private` page) when this
command adds auth too.

admin is released as a tarball on core's GitHub Release, at core's version,
and pinned by sha512 in core's `dist/addons.json`; only core is on npm. Admin
requires `auth`, `ui` and `audit`, and auth requires `mail`, so `urlcode
extensions add admin` adds whichever of them the site lacks, installs each once
at the top level of the site with `npm install --ignore-scripts`, checks the
pins and runs the scaffolds. See
[add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts) for the
site layout and commands. Release publication is not an independent security
review, real-provider deployment evidence or an accessibility certification.

## Build from reviewed source

Deployments that must review and pin exact commits can build every package
locally from a clean checkout of the reviewed commit:

```sh
git checkout REVIEWED_40_CHARACTER_COMMIT_SHA
npm ci --ignore-scripts
npm run build && npm run build:addons
node scripts/pack-addons.ts /absolute/new-private-package-directory
```

One commit identifies every package: they are siblings in this repository.
`pack-addons.ts` packs core and every add-on in dependency order and writes the
`addons.json` that pins each add-on tarball by sha512. Peers are never resolved
from the registry: the workspace resolves them to this tree, which
`scripts/check-workspace-links.ts` enforces. Nothing is published. Run the root
`npm run verify` for the full suite. The tarballs are for local review; a site
installs the release tarballs core pins.

## Wiring

Declare the extensions admin requires, admin itself and their exclusive
mounts. The console's mount must carry auth's policy: auth resolves the
session and verifies CSRF on it, and `onDeny: 404` hides the console from
anyone auth does not sign in. Activation refuses a mount without it
(`/admin/* must carry an auth policy (auth: {onDeny: 404})`). The order the
extensions are declared in does not matter: the runtime activates them in host
order.

```yaml
extensions:
  ui: {version: '1', config: {}}
  audit: {version: '1', config: {}}
  mail: {version: '1', config: {}}
  auth: {version: '1', config: {registration: 'off'}}
  admin: {version: '1', config: {}}
routes:
  /assets/ui/*:
    extension: ui
    methods: [GET, HEAD]
  /account/*:
    extension: auth
    methods: [GET, HEAD, POST]
  /admin/*:
    extension: admin
    methods: [GET, HEAD, POST]
    auth: {onDeny: 404}
```

`urlcode extensions add admin` writes the admin block and route; review and
update the static project revision pin afterwards. The site's `host.mjs` lists
admin after the extensions it requires:

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '@jimhoyd/urlcode-auth/extension';
import admin from '@jimhoyd/urlcode-admin/extension';

export default await composeHost(import.meta.url, [
  audit(),
  mail(),
  ui(),
  auth(),
  admin(),   // or admin({ health })
]);
```

`composeHost` hands admin auth's `AuthExports` v1, the audit exports and the
`ui` kit. Admin holds none of auth's secrets: it reads the signed-in account
(`auth.account(request)`), a CSRF token for its forms (`auth.csrf.token`),
auth's page URLs and the administration API, whose every call names an opaque
actor auth minted from that request's session and re-checks it. It reads the
audit log straight from `AuditExports.query`. Admin imports only types from
`@jimhoyd/urlcode-auth`. `admin({health})` is its only host option. Runtime
activation uses `--host-file host.mjs` and the matching canonical `--origin`.
Console mutations pass auth's CSRF check, which also admits an operator
[`--alias-origin`](../../docs/EXTENSIONS.md#site-origins-and-same-origin-checks);
a CSRF failure answers auth's 403, not 404.

## Permissions

The console answers 404 to a request with no session, an impersonated session,
or an account holding none of the console's permissions: auth's eleven
permissions (`auth.users.read`, `auth.users.reveal`, `auth.users.export`,
`auth.users.manage`, `auth.users.create`, `auth.users.impersonate`,
`auth.sessions.manage`, `auth.roles.read`, `auth.cases.read`,
`auth.cases.manage`, `auth.health.read`) plus audit's `audit.read` and
`audit.export`. Each screen and action checks its own permission; navigation
shows only what the account may use. Grant them through roles in
`operator-service.mjs`; `*` grants everything:

```js
roles: {member: [], support: ['auth.users.read', 'audit.read'], admin: ['*']},
```

## Lifecycle hooks

Admin has no hooks of its own. Every account lifecycle hook is auth's
(`beforeRegister`, `beforeRoleChange`, `onAccountCreated`,
`onAccountStatusChanged`, `onDeletionScheduled`, `onAccountDeleted`), fired by
the auth service for the console's actions exactly as for auth's own pages;
declare them under `extensions.auth.config.hooks` ([auth
README](../auth/README.md#project-level-lifecycle-hooks)). A filter's denial
reaches the console as a 403 with the hook's reason.

## Operating the console

Bootstrap the first administrator through auth's operator CLI using JSON stdin. Writes require recent authentication (auth's five-minute freshness window) and a reason; role, status and session changes run through the auth service's transactional authority checks. Roles themselves remain operator configuration. Masked lists, pagination, permission-filtered navigation and audit records help limit routine exposure.

Cases currently model bounded, two-person approval of specific administrative changes with target-version checks. They are not a complete lost-everything identity-verification process. Establish an operator evidence procedure before using factor-reset cases. The console does not supply all proposed notes, close/reject, requester evidence or reporting workflows.

Invitations, setup links, manual recovery and account operations send email, and auth sends it through the mail extension; without a mail transport the console does not offer them. The invite form appears only on an invite-only site. Impersonation also requires `allowImpersonation` in `operator-service.mjs` and the `auth.users.impersonate` permission; auth notifies the account (`impersonation-started`) before the session starts, and refuses the impersonation (503) when it cannot. Impersonation expires and cannot perform fresh account-security or administrative changes. While it lasts, auth's middleware shows a support banner and marks responses uncacheable on every route an auth policy guards; public pages without an auth policy show nothing. Ending impersonation requires signing back in as the operator.

No real SES, Google or Apple account is provisioned by this package. Keep keys and database backups outside the application project and retain matching configuration.

Apache-2.0. `scripts/pack-addons.ts` only packs; publication happens only through core's release workflow.

## New local installation

After `urlcode extensions add admin`, follow its printed notes: bootstrap the
first administrator with `npx urlcode-auth bootstrap --operator-file
"$PWD/operator-service.mjs"`, configure HTTPS and approve the project revision.
This does not deploy or send mail.

## Extension definition

`@jimhoyd/urlcode-admin/extension` default-exports the admin extension definition (`defineExtension` from `@jimhoyd/urlcode/extensions`). It requires `auth`, `ui` and `audit`, and contributes its `admin/*` templates and `admin.*` catalogue to `ui`. Its `scaffold` returns an empty `extensions.admin` config, the `/admin/*` mount with `auth: {onDeny: 404}` and one-line next steps; it writes no key files and defines no environment. Its `host` builds the console from the exports of auth, audit and ui.

## CI

This package is verified by the repository's own CI on every pull request and push to main: the `workspace-verify` job builds core and the packages admin builds against (ui, audit, mail, abuse and auth) from the same commit — they are siblings in this repository — and runs this package's `verify` across the Node and operating-system matrix in [the CI workflow](../../.github/workflows/ci.yml). `npm test` first runs `scripts/check-sqlite.mjs`, which exits with the SQLite requirement and the bundled version named when the Node release lacks a patched SQLite (3.51.3+, or 3.50.7+/3.44.6+ within those lines), the same rule auth's store enforces at runtime. It needs no cross-repository read credentials. Fork pull requests do not receive repository secrets. Do not switch to `pull_request_target` to run untrusted changes with secrets, reuse broad personal tokens, or weaken repository policy.

Admin is released with core: its tarball, packed from the same commit, is
attached to core's GitHub Release and pinned by sha512 in core's
`dist/addons.json`. There is no admin npm package.

### Operator health observations

Pass `admin({ health: async ({ signal }) => snapshot })` in `host.mjs` to
expose the permission-gated `/admin/health` page (`auth.health.read`). The
callback reads your trusted runtime/provider monitoring integration; the admin
package does not fetch project-supplied URLs or reuse management credentials.
Its two-second deadline aborts the signal, and at most one callback remains in
flight even if an adapter ignores cancellation. A failed or malformed
observation returns an unavailable status without exposing the original error.

```ts
health: async ({ signal }) => ({
  checkedAt: new Date().toISOString(),
  runtime: { status: 'healthy', readiness: 'healthy', version: 'X.Y.Z', routes: 12 },
  sender: 'unknown',
  providers: [{ id: 'google', status: 'unknown' }],
  alerts: [],
})
```

The example shows the shape, not a production probe. Populate it from measured
operator observations; `sender` is the mail delivery status. Status values are
`healthy`, `degraded`, `unavailable`, or `unknown`. Alert codes are
`sender-failed`, `provider-expiring`, `presentation-outdated`, and
`translation-incomplete`. No provider messages, credentials, account
identifiers or arbitrary metadata are returned. The timestamp makes the age of
an observation visible; live provider checks remain a separate operator
acceptance task.

### Audit screens

The dashboard's recent events and the audit page read the audit extension's
log newest first. They need `audit.read`. Readers with both `audit.read` and
`audit.export` can download a complete selected UTC range as JSON at
`/admin/audit/export?from=...&to=...&reason=...`. Actor, subject and action
filters apply to every page; an unknown filter is refused. The export rechecks
the session, permissions and freshness through auth for every page it reads
and before returning the result, and records the export in the audit log
before releasing it. Requests above 5,000 events, 4 MiB, or five seconds fail
with a request to narrow the range; they never silently return a partial file.
Export timestamps are bounded at the start of the request. Audit retention
still limits the available history.

### Users

The users page supports searches by full or masked email, display name, or account ID; role, status, stored credential method (password, passkey, or external identity), mailbox verification, locale, and UTC creation/activity ranges; and ascending or descending sorting. The verified filter describes mailbox proof. Email-code availability is a deployment setting, not a stored per-user credential method. Text matching uses SQLite's built-in case handling, which is case-insensitive for ASCII letters. A filter auth refuses (a bad sort, method, locale or range order) answers 400 with that code.

Filters and sort order carry through pagination and the bounded, audited CSV page export (at most 50 accounts). Email remains masked in tables, JSON lists and CSV. Pagination is live rather than a database snapshot: if the boundary account is deleted or its sort value changes, restart the search. Cursors contain opaque identifiers and hashes, never full email or display-name sort values. Last-seen values use retained device and session activity, not a complete historical activity log; deleted or expired records can change that view.

An account's full email can be revealed only through the explicit **Reveal email address** action, with `auth.users.read` and `auth.users.reveal`, a fresh session, and a reason. The service rechecks the actor's authority and target restrictions and records an audit event. The response remains non-cacheable; routine lists and exports remain masked.

The user directory offers both current-page CSV and **all matching accounts** CSV. Complete export preserves the selected filters and sort, starts at the beginning, and buffers its result privately: more than 5,000 accounts, 4 MiB or five seconds fails with an instruction to narrow filters, without a partial download. Each included subject passes fresh actor/target export authorization and produces its own audit event; failure can leave those audit events even though no file is returned. Read/export permission is checked again before release. CSV masks email identifiers and escapes formula-like cells. This is live cursor pagination, not a database-wide snapshot: concurrent changes can require restarting and new matching rows can appear or disappear during the operation.

Account details expose linked overview, method administration, sessions, recovery,
activity and consent/data sections. Administrator notes are bounded, escaped
`admin.note` audit events; viewing them requires `audit.read`. Session
search filters by account, device label and UTC creation range before pagination.
Method inspection exposes recorded added/last-used timestamps, never provider
subjects or credential key material. Historical timestamps are shown as unknown.

## Shared UI dependency

`@jimhoyd/urlcode-ui` is an exact peer, installed once at the top level of the
site; `composeHost` hands admin the one `ui` kit. The UI peer owns document layout, semantic fields, escaping, themes and
the locale engine; administration behavior remains here.
`scripts/pack-addons.ts` packs the UI archive before its consumers, in
dependency order, from the single reviewed revision. Core can use UI without
auth/admin. Every peer is a sibling in this repository.

## Presentation

The console is one part of the product, while auth retains ownership of
permissions, freshness checks and transactional mutations. The extension
registration publishes a machine-readable `authoring` contract through
`urlcode extensions --host-file ... --json` and MCP `get_extensions`. Follow
those copy and template surfaces before copying a console screen or operation
into the project. The contract also lists focused checks for the edit loop;
full project tests remain the handoff evidence.

Every console screen is an `admin/*` template in the urlcode-ui kit language with a
declared view model and a sample view: dashboard, users, user-detail, sessions, roles,
audit, registrations, cases, health, recovery-cases, account-operations, reveal and
status. The extension computes the view and the template only places it: a template
cannot change a flow, which permission gates a control, the freshness or reason gate
on a mutation, what is escaped, or the CSRF field and headers a page sends. Forms,
table rows, charts and icons arrive in the view as renderer-produced markup built by
the shared primitives.

Admin **requires** `ui`: its definition contributes the templates and the
`admin.*` catalogue through `contributes.ui`, and the runtime activates `ui`
first. Admin reads `ui.kit` per request and never captures it at activation, but
it checks at activation that the kit is there and carries the `admin/*`
templates, and refuses with a message naming what to supply. There is no second
render path.

Screens render through `ui.kit`: the project's theme, layout, hashed stylesheet
and copy apply, the kit builds the console shell (sidebar, page header and skip
target) from the navigation links and account menu admin supplies, a project file
`ui/templates/admin/<screen>.html` shadows the shipped template, and
`urlcode-ui doctor --extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin`
reports every `admin/*` template behind its view model (the CLI reads the
namespace, copy and samples from this package's `./extension` definition; without
the flag it sees the kit alone).

Every console string is an `admin.*` catalogue key (for example
`admin.nav.users`, `admin.ui.noSessions`, `admin.ops.*`, `admin.recovery.*`,
`admin.health.*`). Translate or change them like any other kit copy, in the
project's `ui/copy/<locale>.json`, listed under `extensions.ui.config.languages`;
untranslated keys fall back to English:

```json
{"admin.ui.noSessions": "Aucune session active."}
```

The UX review of these screens is private maintainer material; see
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) and
[ACCEPTANCE.md](ACCEPTANCE.md) for what shipped and what was validated.
