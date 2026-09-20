---
"@jimhoyd/urlcode-auth": patch
---

Report which startup phase an auth store worker reached when its 15-second bound elapses, and reject at once when the worker fails or exits before reporting readiness instead of waiting the bound out. The status and code are unchanged; the detail is attached as the error's cause for operator logs and never reaches a response.
