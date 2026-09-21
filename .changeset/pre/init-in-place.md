---
"@jimhoyd/urlcode": patch
---

`urlcode init` now works in place in a directory that holds only `package.json`, `package-lock.json`, `node_modules` or `.git`, so it can follow `npm init` and `npm install` (the runtime's docs ship in the package, so agents install first). `package.json` is merged: `scripts.start` is added and an existing `@jimhoyd/urlcode` pin is kept. Any other existing file, a conflicting `scripts.start`, invalid JSON or `--manifest` beside an existing `package.json` is refused, and a failed run removes only what it created and restores `package.json`. `init --with` still requires a new or empty directory.
