---
"@jimhoyd/urlcode-mcp": minor
---

Promoted `mcp` out of workspace-only status (#629): it is now a member of every signed `extension-bundles@v…` catalog built by `scripts/prepare-extension-bundles.ts` and `urlcode extension-bundles list`, and `urlcode init --with mcp` scaffolds it. Every MCP tool needs a trusted project handler module under `app/`, and `init --with` cannot place files inside the reviewed route project, so the scaffold wires `createMcpExtension` into the generated `host.mjs` and leaves declaring a server/tool and its handler to the operator; the generated README walks through it with a worked example.
