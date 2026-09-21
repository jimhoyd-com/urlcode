---
"@jimhoyd/urlcode": patch
---

Agent guidance and diagnostics: the generated `AGENTS.md`, the packaged skills and `docs/AI-AUTHORING.md` lead with one bounded query (MCP `get_context`, else `urlcode context --project DIR`) and then retrieve only what the task needs; `llms.txt` and `docs/AI-AUTHORING.md` carry a task-to-feature index and a handler-choice table, and `urlcode context` points at the same built-ins. The MCP server gains `list_skills`, `get_skill`, `search_docs`, `get_example`, `validate_yaml` and `explain_error`. Unknown-key validation errors name the key, suggest the closest allowed key and truncate long allowed-key lists. `urlcode serve` and `dev` name the host and port when the port is taken. Literal NUL bytes were removed from four source files and a check now rejects new ones. The audit advisory names the exact `sandboxReason` line to add.
