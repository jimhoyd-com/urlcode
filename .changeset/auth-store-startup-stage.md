---
"@jimhoyd/urlcode-auth": patch
---

The auth store worker reports the last startup stage it reached, and the readiness-timeout message names it, so a slow start shows where it stalled. The auth scaffold declares what it provides and requires, so `init --with` no longer depends on argument order.
