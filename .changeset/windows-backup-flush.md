---
"@jimhoyd/urlcode-auth": patch
---

Fix backup and restore on Windows by flushing the snapshot through a writable handle. Preserve POSIX directory flushing and document the Windows directory-entry durability limitation.
