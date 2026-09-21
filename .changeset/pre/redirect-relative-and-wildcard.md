---
"@jimhoyd/urlcode": minor
---

Redirects: `redirect.url` may be a root-relative path (`/profiles/{id}`, a single leading slash, no dot segments, placeholders in the path only) answering a path-only `Location`, and a route key ending `/**` after a literal prefix is a redirect-only suffix wildcard whose `{**}` destination placeholder is the remaining segments, each encoded (`/legacy/**` to `https://example.com/modern/{**}`). Exact and `{param}` routes win over it; empty segments, dot segments and captures over 1,024 characters do not match. It is refused on `--target static` and Cloudflare and is not exportable to provider redirect formats. Host- and scheme-based destinations remain refused (#383).
