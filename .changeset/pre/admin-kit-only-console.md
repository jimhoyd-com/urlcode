---
"@jimhoyd/urlcode-admin": minor
---

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
