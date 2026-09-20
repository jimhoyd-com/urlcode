---
"@jimhoyd/urlcode-ui": minor
"@jimhoyd/urlcode-auth": minor
"@jimhoyd/urlcode-admin": minor
---

The maintainer explicitly selected `0.4.0-alpha.3` for core and all three
extensions in this coordinated release. Apply this version directly rather
than computing the next independent alpha. Core's manifest/CLI/MCP version
is updated explicitly because core is not a Changesets workspace package.
The prior pending auth cleanup and auth/admin hook Changesets are consumed
by this release and retained in this directory. Future release grouping is
unchanged; this does not configure permanent fixed versioning.
