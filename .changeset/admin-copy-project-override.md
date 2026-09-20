---
"@jimhoyd/urlcode-admin": patch
---

Project translations of `adminUi.*` ids in `ui/copy/<locale>.json` now reach the admin console.

In a composed site the console copy source is built with `createAdminPresentation({ base: kit.presentation })`, and the admin ids were resolved only from the bundled English, so a project's `adminUi.*` entries were silently ignored. When a base presentation is given, an admin id the base resolves for the request's locale now wins; otherwise the bundled admin English still answers. Hosts that pass no `base` and hosts that supply their own presentation are unchanged.
