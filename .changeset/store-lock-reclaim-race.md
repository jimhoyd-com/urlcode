---
"@jimhoyd/urlcode-store": patch
---

Reclaiming a stale directory lock no longer deletes a fresh lock another process claimed between the staleness check and the reclaim (#549). The stale file is atomically renamed to a unique name and its contents re-checked; a fresh lock found there is linked back and startup is refused. Closing a store removes the lock file only while it still carries that store's own `<pid>:<instance>` identity.
