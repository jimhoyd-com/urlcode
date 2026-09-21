---
"@jimhoyd/urlcode": patch
---

Functions: the long form `function: {source}` without an `args` key now binds every declared path input, as the short form does (write `args: {}` to bind none), and a function receives `context.route.pattern`, the route key that matched, in trusted and sandboxed execution. The generated `AGENTS.md` tells agents not to read or grep `llms-full.txt` for a routine task, and `llms.txt` carries one canonical function example.
