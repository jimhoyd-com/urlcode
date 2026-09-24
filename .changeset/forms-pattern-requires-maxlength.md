---
"@jimhoyd/urlcode-forms": patch
---

A field that declares `pattern` now fails activation unless it also declares `maxLength` of at most 128, as the README already stated. Before, a `pattern` with no `maxLength` was accepted and matched against values up to the body cap.
