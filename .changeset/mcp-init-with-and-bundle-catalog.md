---
"@jimhoyd/urlcode-mcp": minor
---

Promoted `mcp` out of workspace-only status (#629): it is released with core like every other extension, `urlcode extensions add mcp` (or `urlcode init --with mcp`) adds it, and `urlcode extensions available` lists it. Every MCP tool needs a trusted project handler module, so the scaffold wires the extension into `host.mjs` and leaves declaring a server/tool and its handler to the operator.
