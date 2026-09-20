---
"@jimhoyd/urlcode-auth": patch
---

Wait for the SQLite worker to terminate before rejecting failed service initialization, so callers can immediately retry or remove the database without racing an open Windows file handle.
