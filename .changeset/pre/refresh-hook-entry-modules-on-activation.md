---
"@jimhoyd/urlcode-auth": patch
"@jimhoyd/urlcode-admin": patch
---

Re-read a project lifecycle hook's entry module on every activation, so editing a hook file and re-activating in the same process uses the edited code instead of the module Node's ESM loader cached at the first activation. Matches core's existing trusted-route cache-busting; only the entry module is refreshed, so a change to a hook's own dependency still needs a process restart.
