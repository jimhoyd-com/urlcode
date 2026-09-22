---
"@jimhoyd/urlcode": minor
---

Add `review_project` (MCP) and `urlcode review` (CLI), an opt-in, read-only static review of a compiled project and its own function/middleware source. It reports a conservative, well-tested subset of signals — hand-written JSON body validation duplicating `request.body.schema`, manually assembled `Set-Cookie`/session construction, module-scope mutable state, and direct outbound network calls — grouped as `native-alternative`, `extension-alternative`, `gap` or `manual-review`. It never executes project code, reads an environment variable or secret, makes a network call, or claims a declared-but-unregistered extension is active. Refs #428.
