---
"@jimhoyd/urlcode-auth": patch
"@jimhoyd/urlcode-admin": patch
---

Say why `sandbox: true` on a project-level hook is refused.

No behavior change: a hook declaring `sandbox: true` is still rejected at
activation, and hooks still run trusted and in-process. Only the stated reason
changed. The comments, READMEs and the thrown error all claimed core had no
sandbox primitive to isolate a hook call with; core exports `SandboxPool` from
`@jimhoyd/urlcode/sandbox`, so the missing piece is these packages routing a
hook invocation through it, not a core gap. The error text also pointed at
`jimhoyd-com/urlcode-auth#35` and `jimhoyd-com/urlcode-admin#32`, issues in
repositories that were retired by the monorepo migration and no longer resolve;
it points at `docs/EXTENSIONS.md` instead.
