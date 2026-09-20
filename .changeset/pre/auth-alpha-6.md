---
"@jimhoyd/urlcode-auth": patch
---

No change to the published package.

`0.1.0-alpha.5` was tagged at a commit whose `prepare-extension-release.sh`
never built core or ui before typechecking auth against them, so the release
failed at preparation and published nothing. Release tags are immutable and
GitHub runs a workflow from the commit its tag points at, so the fix needs a
new tag on a new commit rather than a retag.
