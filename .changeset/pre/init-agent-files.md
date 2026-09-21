---
"@jimhoyd/urlcode": patch
---

`urlcode init --template page` now also writes `AGENTS.md` and `.mcp.json`. A project whose `package.json` pins the runtime (`--template redirects`, `--with`, `--manifest`) gets an `.mcp.json` that launches the server with `npx --no --package @jimhoyd/urlcode urlcode mcp`, which uses the installed copy and never fetches from the registry; a project without a pin keeps the bare `urlcode` command for a global install.
