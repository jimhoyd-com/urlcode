# Composing a site from ui, auth and admin

One command produces a site that already has accounts, an administration
console and a presentation kit wired together:

```sh
npm install @jimhoyd/urlcode @jimhoyd/urlcode-ui @jimhoyd/urlcode-auth @jimhoyd/urlcode-admin
urlcode init site --with ui,auth,admin
```

This page is the map of what you may then change, and with which tool. It
covers three different activities that are easy to confuse:

| You want to | Use | Code? |
|---|---|---|
| Change what an extension is configured to do | the `config` block in `app/urlcode.yaml` | none |
| Change how its screens look or read | files under `<site>/ui/` | none (templates are data) |
| Run your own logic at one of its lifecycle points | a project function named from that `config` | first-party project JavaScript |
| Add a capability none of the three provides | a new extension package | TypeScript against the runtime contract |

Work down that list, not up. The [declarative-first
principle](PROJECT-DIRECTION.md#design-principle-declarative-first) applies
here as much as it does to routes: reach for the next row only when the one
above it cannot express the requirement.

## What `--with ui,auth,admin` generates

- `site/app/` — the route project: `urlcode.yaml` with an `extensions` block
  per package, and `routes/extensions.yaml` holding `/assets/ui/*`,
  `/account/*`, `/private` and `/admin/*`.
- `site/host.mjs` — the operator host module, the one place that holds code.
  It builds the kit with `createUiExtension`, passes the returned object into
  `authExtension` and `adminExtension`, and lists `ui.registration` first.
- `site/ui/` — `copy/`, `templates/` and `extra.css`, the project's
  presentation overrides, beside the host and **outside** `app/`.
- `site/operator-service.mjs`, `site/data/` — auth's operator service and its
  private key material, mode `0600`.
- `site/README.md` — the merged next steps, environment table and the project
  revision to review and pin.

Nothing about that wiring is manual any more. The generated host registers
`authCatalogue` as a copy source and both `authUiTemplates` and
`adminUiTemplates` as template namespaces, because auth and admin render only
through the kit and refuse to activate without their own templates present.

### Supported combinations

`--with` is an unordered set. Core derives the activation order from each
extension's declared requirements, so the kit is active before anything that
renders through it, whatever order you name them in. A missing requirement
(for example admin without auth) refuses before anything is written.

| `--with` | Result |
|---|---|
| `ui` | Kit only; the host wires no peer catalogue or templates. |
| `ui,auth` | Accounts on `/account/*`, rendered through the kit. |
| `ui,auth,admin` | The full composition above. |
| `auth` or `auth,admin` | Refused: the scaffold names the missing `ui`. |
| `auth,admin,ui` | Refused: `ui` must come before the extensions it renders. |
| `admin` without `auth` | Refused: admin reuses auth's service, CSRF key and revision. |
| `ui,auth,store` | Todo API and CRUD screen, both protected by `auth: true`. |
| `store` or `ui,store` | Refused: the writable mount would be public. Add `auth`, or pass `--allow-public-write` for a documented public-write scaffold; the flag is rejected when auth is composed or `store` is absent. |

Every refusal happens before anything is written, and leaves no directory
behind. There is no auth-without-ui or admin-without-ui configuration in this
revision: the UI primitive fallback was retired, so the kit is the only render
path (see [OPEN-DECISIONS.md](OPEN-DECISIONS.md)).

## Declarative configuration

Each package owns one `extensions.<name>` block. The block itself is core
schema (`version` plus `config`); what may go inside `config` is the
package's own JSON Schema, which you can print rather than guess:

```sh
urlcode extensions --project ./site/app --host-file "$PWD/site/host.mjs" --json
```

The same report is the MCP tool `get_extensions`, and it is the authoritative
answer for both the configuration schema and the per-route policy schema. The
generated site starts from something like this:

```yaml
version: "1"
extensions:
  ui:
    version: "1"
    config:
      theme:
        name: My Site
      languages: [en]
      copy: ui/copy
      templates: ui/templates
      stylesheet: ui/extra.css
  auth:
    version: "1"
    config:
      registration: "off"
  admin:
    version: "1"
    config: {}
```

Routes mount an extension, and policies require one:

```yaml
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
  /private:
    respond:
      text: Signed in
    policies:
      extensions:
        auth: {}
```

See [EXTENSIONS.md](EXTENSIONS.md) for the `auth` route short form, extension
middleware, and the host-file trust boundary.

## Presentation overrides

The `ui` config's `copy`, `templates` and `stylesheet` paths point at the
project's own directories. Nothing here forks a package.

Treat the result as one application. Auth and admin keep ownership of sessions,
CSRF, permissions, validation and mutations; the project owns its brand,
product navigation and the smallest presentation differences it needs. Inspect
`urlcode extensions --host-file ... --json` (MCP: `get_extensions`) and follow
each registration's `authoring.surfaces` before copying package code.

| Override | File | Effect |
|---|---|---|
| Wording and translation | `ui/copy/<locale>.json` | Replaces catalogue ids, including ids the auth and admin packages own. Listed in `languages`. |
| A whole screen | `ui/templates/<name>.html` | Shadows a kit or extension template of that name, for example `ui/templates/auth/sign-in.html` or `ui/templates/admin/dashboard.html`. |
| Styling | `ui/extra.css` | Appended after the kit stylesheet; `{file, replace: true}` replaces it instead. |
| Colours, logo, favicon, radius, font | the `theme` block | Declarative; no file needed. |
| Computed view data | `extensions.ui.config.hooks.transformView` | Adds project data before a named template renders. |
| Product shell and navigation | `extensions.ui.config.hooks.transformPage` | Changes title, layout, navigation, account menu or flash before the shared layout renders. |

A template is data in the kit's own language. It cannot add a script, change
what a form validates, or change what a page sends in headers — so an override
cannot weaken the screen it restyles. Stylesheets containing `@import`,
`script`, `javascript:` or `expression(` are refused.

Names, coverage and what the runtime will actually load:

```sh
npx urlcode-ui list --project ./site --extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin
npx urlcode-ui doctor --project ./site --extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin --copy ui/copy --templates ui/templates --stylesheet ui/extra.css
npx urlcode-ui eject auth/sign-in --out ./site/ui/templates --project ./site --extensions @jimhoyd/urlcode-auth
npx urlcode-ui copy --missing fr --project ./site --extensions @jimhoyd/urlcode-auth --copy ui/copy --languages en,fr
```

`eject` copies the shipped source so an override starts from what ships and
never overwrites an existing file. `ui/` lives outside `app/`, so editing copy
or templates does **not** change the project revision and does not require
re-pinning `PROJECT_SHA256`.

**Name the packages that ship the other namespaces.** `urlcode-ui` is this
kit alone until `--extensions` names them. Each package is resolved from
`--project` with Node package resolution and imported for the namespace it
exports; one that is not installed there is skipped with a note, so the
command still runs. The site's `host.mjs` is never read: it builds services
and reads secrets at its top level, and a read-only `list` or `doctor` must
not run it. With the packages named:

- `list` shows the `auth/*` and `admin/*` names beside the kit's own, each
  with its origin, and `eject auth/sign-in` copies the shipped source.
- `doctor` reports an `expected` view model for an extension template, so its
  `behind` flag tells you when an override of one has fallen behind what
  ships. Its `extensions` field names the namespaces the report covers, so a
  report built without a peer is visible as such.
- `preview auth/sign-in` renders the extension's own sample view model.
- `copy --missing` skeletons cover the auth ids the account screens use.
  Admin-owned `adminUi.*` ids are deliberately not offered: admin composes
  its catalogue onto the kit's presentation rather than registering it there,
  and those translations do not currently reach the console
  ([#227](https://github.com/jimhoyd-com/urlcode/issues/227)).

`urlcode init <directory> --with ui,auth,admin` writes these commands into the
generated README with the flag already set. `@jimhoyd/urlcode-ui` depends on
neither peer; the operator names them.

Run the extension's published `fastChecks` while editing. Theme and copy changes
need no framework build. Template and CSS checks load only the UI kit and named
namespaces; the full runtime validation and request suite remain the final
evidence. A React product frontend with `components.json` should also install
and follow the official shadcn/ui skill. The server template kit uses compatible
tokens but does not accept React components.

Overrides of extension templates and of extension-owned catalogue ids reach
the rendered screens, which is what the regression test below asserts.

## Project functions: lifecycle hooks

A hook is your own function, named from the extension's `config`, that the
extension calls at a lifecycle point it defines. It uses the same source shape
a `function` route uses — a bare path, or `{source, export}` — resolved
relative to the route project.

```yaml
extensions:
  auth:
    version: "1"
    config:
      registration: open
      hooks:
        beforeRegister:
          source: ./hooks/registration-rule.mjs
          export: default
        onSignUp: ./hooks/on-signup.mjs
```

`hooks` remains each package's own config, but core supplies the reference
schema, trusted loader and machine-readable hook contract. `get_extensions`
reports those contracts, so an agent can discover accepted names, purpose and
input/output shapes without guessing from prose.

Hooks are first-party project code and run **trusted and in-process**, the
same default `function` and `middleware` routes have
([FUNCTION-SECURITY.md](FUNCTION-SECURITY.md)). Extension hook contract v1 is
trusted-only; `sandbox: true` is rejected loudly at activation.

### `@jimhoyd/urlcode-ui`

| Hook | Input | Returns | Called |
|---|---|---|---|
| `transformView` | `{template, view}` | the view object to render | Synchronously before each public `ui.kit.render()` or `ui.kit.page()` call. Use it only when theme, copy, templates and CSS cannot express the change. |

For example, `transformView: ./hooks/ui-view.mjs` can add project-computed
navigation or labels to an auth/admin view without editing either package.

### `@jimhoyd/urlcode-auth`

| Hook | Input | Returns | Called |
|---|---|---|---|
| `beforeRegister` | `{email, profile?}` | `{allow: boolean, reason?}` | Before an account is created, on `POST /account/register` and on `POST /account/signup/begin`. |
| `onSignUp` | `{accountId, email}` | ignored | After a genuinely new account is created — on `/account/register`, and on `/account/signup/complete` only when that completion created an account rather than signing an existing one in. |
| `onDelete` | `{accountId, email}` | ignored | After the account owner's own deletion is scheduled. Not on an administrator-initiated deletion, and not on the background purge when the grace period ends. |

### `@jimhoyd/urlcode-admin`

| Hook | Input | Returns | Called |
|---|---|---|---|
| `beforeRoleChange` | `{accountId, currentRoles, requestedRoles, actorId, reason}` | `{allow: boolean, reason?}` | Before roles are applied, after the administrator's permission check. A veto means the auth service is never asked. |
| `onRegistrationApproved` | `{requestId, accountId, email, actorId, reason}` | ignored | After a registration request is approved. |
| `onAccountStatusChanged` | `{accountId, status, actorId, reason}` | ignored | After an account is locked or unlocked. |

### Verdicts and failure

- **A veto is explicit.** A pre-action hook allows only by returning
  `allow: true`. `allow: false`, or no verdict at all, rejects the operation
  with `403` and the hook's own `reason`, or a generic message when it gave
  none. Nothing is written. A hook that *throws* has not returned a verdict:
  the operation is still refused, but as a generic `500`, so return a verdict
  rather than throwing when you mean to deny.
- **Broken hooks fail at activation, not at the first request.** A missing
  module, a source path escaping the project, an export that is not a
  function, or `sandbox: true` all throw while the extension activates, naming
  the hook. The site does not start.
- **A post-action hook cannot undo anything.** `onSignUp`,
  `onDelete`, `onRegistrationApproved` and `onAccountStatusChanged` run after
  the operation has committed. Throwing from one replaces the success response
  with a `500` while the account, approval or status change stands. There is
  no retry and no rollback. Keep them non-throwing: catch your own errors and
  queue the work instead of failing the request.
- **A hook's message is not a channel to the browser.** Only a pre-action
  `reason` is shown. An uncaught error surfaces as a generic failure.
- **An edited hook needs a restart.** Activation re-imports the hook's entry
  module, so a reload picks up an edit to that file — but modules it imports
  stay on Node's module cache, exactly as for trusted route functions.

## TypeScript: implementing a new extension

Only write an extension when a capability is genuinely absent — not to
customize one of the three above. An extension is an operator-installed
package whose host object core activates; it is named in `host.mjs`, never
in YAML. The contract, the activation inputs, `ExtensionActivation.root`,
credential headers and the `projectSha256` pin are in
[EXTENSIONS.md](EXTENSIONS.md) and [TYPESCRIPT.md](TYPESCRIPT.md); the
`scaffold` export that makes a package work with `init --with` is in
[EXTENSIONS.md](EXTENSIONS.md#scaffolding-with-init---with).

If its screens should be themeable the same way auth's and admin's are, it
also exports a template namespace (and, if it ships English wording, a
catalogue) for a host to pass to `createUiExtension`. That is what makes
`ui/templates/<yourname>/<screen>.html` work in a consumer project without a
fork.

## What this page does not claim

The composition, the refusals and the override path are exercised by
`test/workspace-scaffold.integration.ts`, which runs `init --with` against the
built packages, drops a template and a copy catalogue into the generated
`ui/` directory and asserts both reach a rendered auth screen and a rendered
admin screen. That runs in-process against the generated host: no HTTP
listener, TLS proxy, browser or deployed site is exercised, and no published
npm tarball is checked against this checkout.
