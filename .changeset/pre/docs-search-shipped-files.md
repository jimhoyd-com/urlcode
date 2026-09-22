---
"@jimhoyd/urlcode": patch
---

Fix `urlcode docs search` and MCP `search_docs` throwing "Required file or directory not found" on every installed copy of the package: `package.json`'s `files` field never listed `docs/`, so `searchDocs`'s `docs/AI-AUTHORING.md`, `docs/YAML-REFERENCE.md`, `docs/TOOLING.md` and `docs/FUNCTION-SECURITY.md` reads only ever worked from a repository checkout. Ship those four files (not the rest of `docs/`, to stay within the release size budget) and add a packaging test that runs `docs search` against the real installed tarball.
