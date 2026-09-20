---
"@jimhoyd/urlcode-ui": minor
---

The scaffold wires kit-rendering peers into the host it generates. `scaffold()` reads the composed `names` and emits `createUiExtension({..., sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]})`, importing each peer it needs, so `urlcode init --with ui,auth,admin` produces a project that activates. Previously it always wrote `sources: []` and no `extensions`, which left auth and admin without their copy and templates. `ui` alone still registers nothing and imports no peer.

Name `ui` first: the runtime activates extensions in the order `urlcode.yaml` declares them, core writes that file in `--with` order, and auth and admin both refuse to activate before the kit is active.
