---
"@jimhoyd/urlcode-auth": patch
---

A successful password reset now clears the account-wide password-attempt budget, so the owner can sign in with the new password immediately (#546). Per-client auth budgets (the per-client password budget and the abuse-policy `client`/`signupClient` limits) now key an IPv6 client by its /64 network and an IPv4-mapped IPv6 address as IPv4 (#547). In waitlist mode, the registration-attempt notice for an already-known address is sent without holding the reply (#548).
