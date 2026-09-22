---
"@jimhoyd/urlcode-auth": patch
---

An unverified account's first mailbox proof (password reset, email sign-in code, or a verification link submitted without that account's own session) now removes every passkey, linked identity, authenticator, recovery code, remembered device, pending email change, token and session established before it, and the password unless the proof sets one, recording an `account.claimed` audit event. A claiming email code no longer asks for those earlier factors. `consumeVerification` accepts the verifier's session token, and `POST /verify` answers `passwordResetRequired: true` when the password was removed. Already verified accounts are unchanged.
