---
"@jimhoyd/urlcode-auth": patch
---

`urlcode-auth init` now writes a `package.json` that pins this package and each declared peer at the exact version installed beside it, instead of a manifest with no dependencies at all; `initAuthentication` returns those pins and names any peer it could not resolve. Nothing is installed: running `npm install` in the generated directory to produce a lockfile stays the operator's explicit step, and no upgrade command exists.
