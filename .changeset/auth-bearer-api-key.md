---
"@jimhoyd/urlcode-auth": patch
---

Added bearer/API-key authentication as an optional capability of the auth extension (#571): `AuthService.issueApiKey`/`listApiKeys`/`revokeApiKey`/`authenticateApiKey`, hashed at rest with the same scrypt derivation used for passwords, looked up by a public id rather than a hash of the secret; the `urlcode-auth api-key-issue`/`api-key-list`/`api-key-revoke` CLI commands; and a route short form, `auth: {bearer: {scopes: [...]}}`, exclusive of the existing session keys, enforced with RFC 6750-shaped 401/403 responses. The verified key's id/name/scopes are not yet exposed to the protected route's own function/middleware context (#618).
