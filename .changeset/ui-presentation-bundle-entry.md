---
"@jimhoyd/urlcode-ui": minor
---

Extension bundles can now publish a separately named, signed public entry for safe project-consumption primitives, independently versioned and integrity-locked from the extension's host-activation entry (#522). `ui-presentation` is the first such entry: it locks this package's root `dist/index.js` (`renderDocument`, `createPresentation`, `escapeHtml`, `table`, `field`, `button`, and the rest of the Node-free presentation surface), never `dist/host/index.js` (the `ui` bundle's host-activation entry). Install it with `urlcode extension-bundles install ui-presentation --bundle-release extension-bundles@vX.Y.Z`, then `loadExtensionBundle` it directly into a plain trusted function or middleware route — no host file, no `extensions.ui` configuration, no `/assets/ui/*` mount. It is not a scaffoldable extension and is not meant for `urlcode init --with`.
