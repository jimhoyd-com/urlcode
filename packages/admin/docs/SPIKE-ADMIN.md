# Spike: an administration extension (`urlcode-admin`)

> **Update (2026-09-19):** this spike was written while core had a native link
> store, a `urlcode links` CLI and a private management API for links. All three
> were removed from core when `link` was extracted, and the `urlcode-short` and
> `urlcode-dynamic-link` packages that received them have since been retired,
> unpublished and their repositories deleted. Stored short links are now
> declared through the `store` extension's `extensions.store.config.shortLinks`
> (docs/STORE.md), which the admin console does not manage. Everything below about links — the "Links" console section
> and the sentences that mention the site's live links or a link management API
> (the introduction and sections 1, 2, 3, 6 and 8) — therefore describes
> **withdrawn scope, not
> deferred scope**: it is not waiting on a later release, because there is no
> longer a link surface for the console to render. The rest of the spike is
> unaffected. The body is kept as the dated design record it is.

> **Update (2026-09-19):** the console now renders **only** through the
> `urlcode-ui` kit. Where this spike describes admin composing its own pages and
> console shell from shared primitives, with the kit as an optional upgrade,
> that dual arrangement has been retired: `adminExtension` requires the `ui`
> extension and refuses to activate without an active kit carrying the `admin/*`
> templates. The screens, flows, permissions and gates the spike describes are
> unchanged — only the single layer that turns a view into a document. See
> [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md), which takes
> precedence. The body below is kept as the dated design record it is.

Status: design proposal, kept as the source plan. The implementation lives in this repository; [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md) records what is built and what remains, and takes precedence where this text differs. Companion to the
[auth spike](../../auth/docs/SPIKE-AUTH.md), which it requires. Where the auth extension
gives each person their own accounts page, this one gives the people who
run the site a place to manage everyone else: users, sessions, roles,
recovery cases and the audit trail, and later invitations, organizations and
the site's live links. It follows the same principles and adds no new
runtime seam: everything it needs, auth already asked for.

## 1. What it is and is not

It is the operator-facing counterpart of the accounts page. A site with
`urlcode-auth` has accounts; `urlcode-admin` is how an authorized person
sees and acts on them without the CLI or the database.

It is not the runtime's management API. When this spike was written the runtime
had a private, credentialed HTTP surface for live links; that listener was
removed from core with the link store, so what remains today is the
`/_urlcode/*` health, readiness and metrics endpoints. Those stay as they are: infrastructure endpoints for
operators and tooling, authenticated by operator credentials, never by a
user session. This extension is a set of pages for people with a role,
authenticated by `urlcode-auth`. In a later release it may render a view
over the link management API, but it does not replace or re-implement it.

## 2. How a project adds it

<!-- local-links: historical -->
> **Historical:** this section predates the monorepo. Auth and admin now live
> in `packages/auth` and `packages/admin` of the URLCode repository and new
> sites get them as signed extension bundles through
> `urlcode init --with ui,auth,admin`; the npm install below is not a supported
> path.

```sh
npm install @jimhoyd/urlcode-auth @jimhoyd/urlcode-admin
npx urlcode-auth init
npx urlcode-admin init
```

`urlcode-admin init` writes `admin.yaml`, adds it to `includes`, and adds
the plugin line after the auth plugin in the host file. `admin.yaml`
after `init`:

```yaml
version: "1"
extensions:
  admin:
    requires: { role: admin }         # who may open the console at all
    stepUp: 10m                        # fresh authentication for every write
    impersonation: off                 # off | on; on requires a reason and shows a banner
    sections: [dashboard, users, sessions, roles, audit, cases]   # later: invitations, organizations, links
routes:
  /admin/*:
    extension: admin
    policies: { auth: { role: admin, onDeny: 404 } }   # 404 hides the console from everyone else
```

The plugin refuses activation when no plugin providing `auth` is active
(the original or any fork that keeps the auth contract), when that
provider's contract version is outside the range this release was tested
with, or when the
`/admin/*` route carries no `policies.auth` requirement, so the console
cannot be mounted unprotected by mistake. The `requires` role must exist in
the auth roles; `init` adds `admin: ["*"]` when it is missing and says so.

## 3. Sections

Each section is a server-rendered page on the auth extension's template
kit, so the console looks like the accounts page and the project's theme,
copy catalogue and layout override apply to both.

| Section | What an admin can do | Every action |
|---|---|---|
| **Dashboard** | The first page: counts of accounts (active, locked, pending deletion), sign-ups and sign-ins per day for the last 30 days by method and outcome, failed sign-ins and lockouts, open recovery cases, pending invitations later; the runtime's health and readiness, route count and version; the last twenty audit rows; alerts the extensions raise (a sender that failed, a provider whose credentials expire, a template behind its view model, a language missing ids). Every number links to the filtered list behind it. Charts are server-rendered SVG from the kit, no client library | read-only |
| **Users** | **List**: search by masked identifier, display name or id; filter by status, role, method, verified, created or last-seen range, language; sort; paginate; export the filtered list as CSV without secrets; bulk actions on a selection (assign role, lock, resend verification) each with a typed confirmation and one audit row per user. **Create**: an account by email with a role, with an invitation sent or a one-time set-up link shown once. **Detail**, in tabs: *Overview* (identifiers and verification state, status, roles, created, last seen, language, terms version, notes an admin leaves for other admins); *Sign-in methods* (each method's kind, name, added and last-used dates, never a secret; remove one with the cooldown notice to the user; force a password reset; disable the second factor with reason); *Sessions* (this user's sessions, revoke one or all); *Recovery* (recovery contacts and their cooldown state, open cases, issue a one-time recovery link); *Activity* (this user's audit rows, and the admin actions taken on them); *Data* (export this user's data, start or cancel deletion in its grace period, view the consent record). **Actions** on the detail page: lock and unlock with reason, change roles, resend verification, verify an identifier by hand with reason, change the user's email at their request with the notice to both addresses, impersonate when enabled, delete | writes an audit row with the admin, the subject, the reason and the request id, and sends the user the declared notice |
| **Sessions** | Active sessions across all users, filter by user, device or age; revoke one, revoke all for a user, revoke all sessions site-wide (typed confirmation) | as above |
| **Roles** | View roles and their permissions as declared in YAML; see who holds each role; assign and remove. Roles themselves are YAML and read-only here: changing what a role means is a code change reviewed in a pull request, changing who holds it is an operation | as above |
| **Audit** | The store's audit log across auth and admin collections: filter by actor, subject, action, time; export a range as JSON; the row for an impersonated action shows both the admin and the user | read-only |
| **Cases** | Open recovery cases from the auth extension's "lost everything" flow: what the person provided, the account's recovery contacts and last-known devices, notes; resolve by restoring access (which requires two admins when the site declares `cases.approvers: 2`) or by closing | as above |
| **Invitations** (later) | Invite by email with a role; see pending, resend, revoke | |
| **Organizations** (later) | Organizations, members, roles, domain verification, SSO connections, SCIM tokens | |
| **Links** (later) | A view over the runtime's link management API for the project's live links, using the operator credential the admin holds, not the session | |

Cross-cutting rules, inherited from the accounts page and tightened:

- Every write needs a fresh authentication within `stepUp`, and the
  prompt names the action.
- Every write is audited with a reason field the admin must fill for
  lock, unlock, factor removal, deletion and impersonation.
- Identifiers are masked by default; an admin reveals one with a click,
  and the reveal is itself an audit row.
- Impersonation is off unless declared, requires a reason, shows a banner
  on every page, expires after `impersonation.maxAge` (default 15
  minutes), cannot perform step-up actions as the user, and notifies the
  user afterwards.
- Nothing in the console can change the YAML: roles, methods and policies
  are read-only views. Configuration is code; the console is operations.
- The console is hidden with `onDeny: 404` by default, so its existence is
  not advertised to signed-out visitors or to users without the role.

## 4. Permissions inside the console

`requires` gates the door; permissions gate the rooms. The extension
declares its own permissions in the auth vocabulary so a site can split
support staff from administrators:

```
admin.dashboard.read
admin.users.read    admin.users.write    admin.users.create   admin.users.delete   admin.users.impersonate
admin.sessions.read admin.sessions.write
admin.roles.read    admin.roles.write
admin.audit.read    admin.audit.export
admin.cases.read    admin.cases.write
```

A `support` role with the `read` permissions plus `admin.sessions.write`
and `admin.cases.write` covers a help desk; `admin: ["*"]` covers
everything. Sections a role cannot read do not appear in its navigation.

## 5. What it reuses and what it adds

Reused from the runtime and the auth extension, with nothing new asked of
the runtime:

- The `extension` route handler and `extensions` block, the plugin seam,
  `policies.auth`, the request context bag.
- The store binding: the console reads the `auth.*` collections through
  an interface the auth extension exports for this purpose
  (`@jimhoyd/urlcode-auth/admin`), never by opening the collections
  itself, so the auth data model stays private to its owner and every
  write goes through the auth extension's own validation and audit.
- The template kit, theme variables, copy catalogue and override order
  from [`urlcode-ui`](../../ui/docs/SPIKE-UI.md), shared by every extension.
- Observability events (`admin.user.lock`, `admin.session.revoke`,
  `admin.impersonate.start`, …) and metrics on the runtime seam.

Added by this extension: the pages, the permission vocabulary, the
`cases` workflow with dual approval, the impersonation banner and limits,
and its own `admin.*` audit actions in the shared audit log.

## 6. Scope for the first release

Dashboard, the full users section above, sessions, roles (assignment
only), audit and cases. Impersonation ships but is off by default. Invitations, organizations and the links view
wait for the auth releases they depend on. The first release follows the
first auth release; it cannot ship before it.

## 7. Forkable

The same rule as the auth extension: `admin` is a contract
(`@jimhoyd/urlcode-admin-contract`), this package is one implementation,
and it depends on a provider of `auth`, never on a package name. See the
[extension contract](../../../docs/EXTENSIONS.md).

## 8. Open questions

- Whether `cases` belongs here or in the auth extension's CLI only until
  a site has a support team; the page is small, so the proposal keeps it.
- Whether the links view should ever use a user session, or always the
  operator credential. The proposal says operator credential, held in the
  server file and never in the browser.

## 9. Naming

Four names are in play: the npm packages, the workspace directories and the
extension keys in YAML. They should agree. (This spike was written when each
package had its own repository; all four now live in `jimhoyd-com/urlcode`.)

| | Runtime | UI kit | Auth | Admin |
|---|---|---|---|---|
| Source | repository root | `packages/ui` | `packages/auth` | `packages/admin` |
| npm | `@jimhoyd/urlcode` | `@jimhoyd/urlcode-ui` | `@jimhoyd/urlcode-auth` | `@jimhoyd/urlcode-admin` |
| YAML extension key | | `extensions.ui` | `extensions.auth`, `extension: auth` | `extensions.admin`, `extension: admin` |
| CLI | `urlcode` | `urlcode-ui` | `urlcode-auth` | `urlcode-admin` |
| Default mount | | | `/account` | `/admin` |

The names make sense, with two cautions:

- `admin` is a word the runtime's docs already use for its own operator
  surface (management API, `/_urlcode/*`). The sentence that separates
  them is in section 1 and belongs in both READMEs: the runtime's
  management surface is for operators with credentials; the admin
  extension is for people with a role. `urlcode-console` would avoid the
  overlap but is less obvious to a person searching npm, so `admin` is
  the recommendation.
- Separate repositories rather than one `urlcode-extensions` monorepo is
  right while the extensions have different release cadences and a hard
  dependency between them. The shared parts (templates, theme, copy
  catalogue, override resolution) are their own package from the start,
  [`urlcode-ui`](../../ui/docs/SPIKE-UI.md), so `admin` never imports UI from `auth`
  and the next extension starts from the same kit.
