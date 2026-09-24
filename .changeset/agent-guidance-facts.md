---
"@jimhoyd/urlcode-ui": patch
"@jimhoyd/urlcode-forms": patch
---

Correct the package `llms.txt` guidance: auth and admin render their templates through the kit when the host supplies it (the ui guide still said they used the primitives), and forms ships in the signed `extension-bundles@v…` release rather than being unreleased. Both claims are now checked against the implementation by `scripts/check-agent-facts.ts`.
