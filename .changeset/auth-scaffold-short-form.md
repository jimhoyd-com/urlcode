---
"@jimhoyd/urlcode-auth": patch
---

The `urlcode init --with ui,auth` scaffold now protects its `/private` route with the documented route-level short form `auth: true` instead of the long form `policies: {extensions: {auth: {}}}`. Both spell the same requirement (any signed-in principal); existing projects keep working unchanged.
