---
"@jimhoyd/urlcode-auth": minor
---

Breaking: the `ui` extension is now required. Every account screen renders through the `urlcode-ui` kit; the shared-primitive fallback is gone. `authExtension({ui, ...})` refuses activation when `ui` is absent or when the runtime has not activated it, naming the missing piece instead of failing per request. Declare `ui` before `auth` in `urlcode.yaml` (with its asset route) and list `ui.registration` before `authExtension` in the host: the runtime activates extensions in the order `urlcode.yaml` declares them. `@jimhoyd/urlcode-ui` was already a required peer dependency, so nothing new needs installing; what changes is that the extension must be supplied and active. `ScreenOptions.ui` is no longer optional and `screenObserver` no longer reports a render path.

Scaffolding composes the kit for you: `urlcode init --with ui,auth` and the standalone `initAuthentication` now write a project whose `urlcode.yaml` declares `ui` first and whose host passes it to `authExtension`. The scaffold refuses when `ui` is missing, or ordered after `auth`, before anything is written.
