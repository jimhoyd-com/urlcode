---
"@jimhoyd/urlcode-admin": patch
---

The admin scaffold declares that it requires `ui.kit` and `auth.service`, so `init --with` no longer requires naming ui first: any order gives the same site, and a missing dependency is refused before anything is written, naming it.
