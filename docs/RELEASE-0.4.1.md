# URLCode 0.4.1

Core, UI, auth and admin share this explicitly selected stable version. This does not enable permanent fixed versioning. Internal peer minimums advance to this version; install the coordinated set together.

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.1 @jimhoyd/urlcode-ui@0.4.1 @jimhoyd/urlcode-auth@0.4.1 @jimhoyd/urlcode-admin@0.4.1
```

This coordinated release moves core, UI, auth and admin from `0.4.0-alpha.3` to stable `0.4.1`. It makes the reviewed monorepo release line available through npm `latest` and keeps the four packages' peer minimums aligned.

The runtime retains its existing trust model: project functions and middleware run trusted in Node by default; routes declaring `sandbox: true` retain QuickJS/WASM isolation. The stable label is a distribution decision, not an independent security assessment or hostile multi-tenant readiness claim.

Release preparation now supports an explicit exit from alpha. Publication promotes the exact signed candidate archives, pins their manifest digest in immutable tags, checks actual npm installability, and updates the standalone starter to the published core version. Historical alpha versions and tags remain unchanged.

### admin-kit-only-console.md

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

### auth-kit-only-render.md

Breaking: the `ui` extension is now required. Every account screen renders through the `urlcode-ui` kit; the shared-primitive fallback is gone. `authExtension({ui, ...})` refuses activation when `ui` is absent or when the runtime has not activated it, naming the missing piece instead of failing per request. Declare `ui` before `auth` in `urlcode.yaml` (with its asset route) and list `ui.registration` before `authExtension` in the host: the runtime activates extensions in the order `urlcode.yaml` declares them. `@jimhoyd/urlcode-ui` was already a required peer dependency, so nothing new needs installing; what changes is that the extension must be supplied and active. `ScreenOptions.ui` is no longer optional and `screenObserver` no longer reports a render path.

Scaffolding composes the kit for you: `urlcode init --with ui,auth` and the standalone `initAuthentication` now write a project whose `urlcode.yaml` declares `ui` first and whose host passes it to `authExtension`. The scaffold refuses when `ui` is missing, or ordered after `auth`, before anything is written.

### auth-store-startup-diagnostics.md

Report which startup phase an auth store worker reached when its 15-second bound elapses, and reject at once when the worker fails or exits before reporting readiness instead of waiting the bound out. The status and code are unchanged; the detail is attached as the error's cause for operator logs and never reaches a response.

### pin-generated-site-dependencies.md

`urlcode-auth init` now writes a `package.json` that pins this package and each declared peer at the exact version installed beside it, instead of a manifest with no dependencies at all; `initAuthentication` returns those pins and names any peer it could not resolve. Nothing is installed: running `npm install` in the generated directory to produce a lockfile stays the operator's explicit step, and no upgrade command exists.

### ui-scaffold-peer-registration.md

The scaffold wires kit-rendering peers into the host it generates. `scaffold()` reads the composed `names` and emits `createUiExtension({..., sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]})`, importing each peer it needs, so `urlcode init --with ui,auth,admin` produces a project that activates. Previously it always wrote `sources: []` and no `extensions`, which left auth and admin without their copy and templates. `ui` alone still registers nothing and imports no peer.

Name `ui` first: the runtime activates extensions in the order `urlcode.yaml` declares them, core writes that file in `--with` order, and auth and admin both refuse to activate before the kit is active.

Publish to the npm `latest` channel in core → UI → auth → admin order after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged; this stable release advances `latest`. Changesets prerelease mode is exited. Update the standalone starter's exact core pin after registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
