---
"@jimhoyd/urlcode-ui": patch
---

`crudScreen` renders a data-bound list with create, inline edit and delete for a collection declared in `extensions.store`, configured with `screens` (per-field labels and column selection), served with a nonce'd, content-hashed client script and no inline script; an edit in progress survives re-render and a failed update rolls its optimistic change back. `field()` gains `textarea` and `select` controls with `textarea@1` and `select@1` kit partials. `renderDocument` takes an optional `style: {nonce}` and `documentContentSecurityPolicy(nonce)` returns the matching strict CSP, so those pages run under the default `oshp` profile. `init --with ui,store` composes the screen.
