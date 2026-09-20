---
"@jimhoyd/urlcode-auth": patch
---

No change to the published package.

`0.1.0-alpha.4` was versioned and tagged but never published. Its tag was
created before the peer-floor gate was fixed, and GitHub runs a workflow from
the commit the tag points at, so re-running that release would have re-executed
the broken gate. Moving a tag onto a later commit is worse than spending a
version number, so the version moves instead and the inert `0.1.0-alpha.4` tag
is left pointing at a commit that never shipped.

`@jimhoyd/urlcode-ui@0.1.0-alpha.6` and `@jimhoyd/urlcode-admin@0.1.0-alpha.4`
published normally; this only affects auth.
