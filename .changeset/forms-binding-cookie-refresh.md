---
"@jimhoyd/urlcode-forms": patch
---

The CSRF binding cookie is re-issued with the same value and a fresh 10-minute `Max-Age` on every form render, including a 422 re-render, so a form loaded late in the original cookie's lifetime no longer fails with 403 on submit (#551).
