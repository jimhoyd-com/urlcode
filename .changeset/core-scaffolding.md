---
"@jimhoyd/urlcode": patch
---

Scaffolding: `urlcode init <dir> --with` treats its extensions as an unordered set. Scaffolds declare `provides`, `requires`, `after` and `conflicts`, and core orders them canonically, so any permutation gives the same site and revision pin; a missing requirement, conflict or cycle refuses before anything is written. Risky scaffolds are acknowledged with a repeatable `--ack <extension>:<id>` flag that core hands to scaffolds as an opaque set and rejects when no scaffold consumed it (`ScaffoldRequest.acknowledgements`, `ScaffoldResult.acknowledged`, `routeNotes`). `urlcode init <dir> --template page` writes the smallest page-only project. Extensions that need these contracts must declare a core peer floor that includes them.
