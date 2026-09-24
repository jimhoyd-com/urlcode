---
"@jimhoyd/urlcode-ui": patch
"@jimhoyd/urlcode-auth": patch
"@jimhoyd/urlcode-admin": patch
"@jimhoyd/urlcode-store": patch
"@jimhoyd/urlcode-forms": patch
---

`engines.node` now reads `>=22.13.0`, matching the documented installed-package
floor (core's own `engines`, CONTRIBUTING.md, docs/INSTALL.md) instead of the
stricter `>=22.18.0` these packages had declared since the monorepo
consolidation. Nothing in a built package's `dist/` needed the higher floor;
`>=22.18.0` only applies to running TypeScript source directly from a clone
(#568). A new CI leg (`package-floor-smoke`) pins Node 22.13.0 exactly and
builds every extension package there.
