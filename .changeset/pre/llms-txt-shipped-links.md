---
"@jimhoyd/urlcode": patch
---

Fix `llms.txt` contradicting itself on stored short links: the extension-reference section said no supported extension provides them and told authors to report a gap, while store's `shortLinks` capability actually covers create, redirect, missing-code and click-count without a function. Document `shortLinks` consistently and point relative doc links (`docs/`, `packages/*`, `ROADMAP.md`) that are not part of the published npm package at their canonical GitHub URLs instead, since `docs/` is not shipped in the tarball. Add a packaging test asserting every relative link in `llms.txt` resolves inside the published tarball.
