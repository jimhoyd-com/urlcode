# @jimhoyd/urlcode-admin

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
