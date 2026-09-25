# @jimhoyd/urlcode-admin

## Unreleased

**Extension split (breaking).** Admin now requires `auth`, `ui` and `audit`, and is built only on auth's `AuthExports` v1 and audit's `AuditExports`; it imports auth's types only and holds none of auth's secrets. No aliases or migrations:

- The `/admin/*` mount must carry `auth: {onDeny: 404}` (the scaffold writes it); activation refuses without it. Auth resolves the session and verifies CSRF on it, so a CSRF failure is auth's 403.
- Removed: `adminExtension`, `createAdministrationRuntime`, `withSupportBanner` (the banner is auth's middleware now), `createAdminPresentation`, the send callbacks (`sendInvitation`, `notifyImpersonation` and the rest; auth sends every email through mail), `authMount`, and admin's hooks (`beforeRoleChange` and `onAccountStatusChanged` are auth's, fired for the console's actions; `onRegistrationApproved` is gone, use auth's `onAccountCreated`). `admin({health})` is the only host option.
- Permissions: the audit screens need `audit.read`, and range exports `audit.export`, instead of `auth.audit.*`.
- Recent audit events on the dashboard and user detail are the newest, not the oldest (#746).
- Console copy is `admin.*` catalogue keys contributed to `ui`, translated in `ui/copy/<locale>.json`.
- The invite form appears only on an invite-only auth site with mail delivery. The audit export form has a reason field; an unknown audit filter is 400.

Console mutations accept the operator's site-wide alias origins (`--alias-origin`, `aliasOrigins`) through auth's same-origin check; unlisted origins are still refused (#717).

`urlcode extensions add` now installs only the capability, and `--example` writes demos (#711). admin's scaffold was already capability-only (the `/admin/*` console) and ships no example; its notes now say that auth's `/account` mount is a default, changed with `admin({authMount})`.

Project hooks (`beforeRoleChange`, `onRegistrationApproved`, `onAccountStatusChanged`) receive core's generic hook context, `{requestId, env}`, as a second argument (#678).

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

The admin scaffold declares that it requires `ui.kit` and `auth.service`, so `init --with` no longer requires naming ui first: any order gives the same site, and a missing dependency is refused before anything is written, naming it.

Keep published archives to built runtime files and required legal, security and usage material. Auth installations no longer pull the AWS SES SDK unless the operator selects the built-in SES sender.

## 0.4.2

Align the coordinated stable release at `0.4.2` on npm’s `latest` channel. Internal peer minimums advance to this release.

Project translations of `adminUi.*` ids in `ui/copy/<locale>.json` now reach the admin console.

In a composed site the console copy source is built with `createAdminPresentation({ base: kit.presentation })`, and the admin ids were resolved only from the bundled English, so a project's `adminUi.*` entries were silently ignored. When a base presentation is given, an admin id the base resolves for the request's locale now wins; otherwise the bundled admin English still answers. Hosts that pass no `base` and hosts that supply their own presentation are unchanged.

## 0.4.1

Align the coordinated stable release at `0.4.1` on npm’s `latest` channel. Internal peer minimums advance to this release.

This coordinated release moves core, UI, auth and admin from `0.4.0-alpha.3` to stable `0.4.1`. It makes the reviewed monorepo release line available through npm `latest` and keeps the four packages' peer minimums aligned.

The runtime retains its existing trust model: project functions and middleware run trusted in Node by default; routes declaring `sandbox: true` retain QuickJS/WASM isolation. The stable label is a distribution decision, not an independent security assessment or hostile multi-tenant readiness claim.

Release preparation now supports an explicit exit from alpha. Publication promotes the exact signed candidate archives, pins their manifest digest in immutable tags, checks actual npm installability, and updates the standalone starter to the published core version. Historical alpha versions and tags remain unchanged.

**Breaking:** the console renders only through the urlcode-ui kit. `ui` is now a
required option of `adminExtension` and of `createAdministrationRuntime`'s
`admin` block, which is itself no longer optional.

`@jimhoyd/urlcode-ui` was already a required peer dependency, so nothing new has
to be installed. What changed is that the `ui` *extension* must now be supplied
and active: the primitive render path — the same `admin/*` templates rendered
through the shared primitives inside a console shell admin built itself — is
gone, along with the `RenderPath` seam, the `activeKit()` helper, the
`ScreenOptions.shell.sidebar` markup and `src/admin-presentation.ts`. The kit
builds the sidebar, page header and skip target from the `nav` items and account
`menu` admin supplies, so the console shell has one representation instead of
two. `ScreenOptions.preferences` is gone too: the kit layout now renders through
the same resolved presentation as the body, so the document's `lang` matches the
copy on the page.

Activation refuses up front, rather than failing per request in production, when

- `ui` is missing,
- `ui` is supplied but not active yet — declare `ui` before `admin` under
  `extensions` in `urlcode.yaml`, since the runtime activates in declaration
  order, and mount its assets route, or
- the kit was built without `adminUiTemplates`.

To migrate, build the extension with admin's templates and pass it:

```js
const ui = createUiExtension({projectSha256, projectRoot, sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]});
adminExtension({service, csrfKey, projectSha256, ui});
```

Scaffolding emits that wiring for you: `scaffold()`, `initAdministration` and
`urlcode init --with ui,auth,admin` compose the kit and register the admin
templates with it. `ui` is now required, and must come before `admin`; the
scaffold refuses otherwise before writing anything.

<!-- local-links: historical-file -->

## 0.4.0-alpha.3

- Refresh lifecycle hook entry modules on each activation; changes to imported hook dependencies still require a process restart.
- Include deterministic resource cleanup and Windows portability corrections.
- Align the release with core/UI/auth at `0.4.0-alpha.3` and require their coordinated peer floors.

## 0.1.0-alpha.4

### Patch Changes

- Move into the core repository as `packages/admin`.
  
  No API change. The package's source moved from `jimhoyd-com/urlcode-admin` into
  `jimhoyd-com/urlcode` as a workspace package. Its `peers.json` pinned core,
  auth and ui separately, and those pins disagreed with auth's own; a workspace
  makes that drift structurally impossible, so the file and its test are gone.
  
  - Seven lint errors fixed, since core's `eslint .` now covers this package. A
    thrown symptom error was discarding the underlying failure and now attaches
    it as `cause`, so the stack still names the import that failed.
  - Trust-model prose was already correct and needed no changes.
