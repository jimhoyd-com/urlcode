---
"@jimhoyd/urlcode-ui": patch
---

The `./host` HMAC helpers no longer throw on a malformed token. `verifyHmac` now accepts only the canonical encoding of an HMAC-SHA256 (64 lowercase hex or 43 unpadded base64url characters, rejecting base64url trailing-bit variants) and returns `false` for anything else; before, a same-length value containing characters outside the alphabet decoded to a shorter buffer and `timingSafeEqual` threw. `readSignedToken` returns `undefined` for every malformed input, so a forms POST carrying a tampered `csrf` field is answered 403 instead of a server error.
