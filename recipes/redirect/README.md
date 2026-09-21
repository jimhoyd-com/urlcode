# Redirects: fixed, parameterized, query-preserving and 404

Run `urlcode validate --local --project .` and `urlcode serve --project .`.

- `/docs?campaign=launch&private=discarded` redirects (301) to
  `https://example.com/documentation?campaign=launch`. Only the declared
  `campaign` key is forwarded; everything else, including `private`, is
  dropped. Replace the example destination before deploying.
- `/users/{id}` redirects (308, method- and body-preserving) to
  `https://example.com/profiles/{id}`, substituting the declared path
  parameter into the destination.
- Any other path, such as `/missing` or `/users/42/extra`, answers the
  runtime's default 404. `DELETE /docs` answers 405 (only GET/HEAD match by
  default). Add top-level `site: {notFound: 404.html}` for a custom 404 page
  instead of the plain default.

For the shapes this recipe does not cover — a root-relative or `/**` suffix
redirect, or a host/scheme-based redirect — run
`urlcode context --project . --task redirects` (MCP `get_context
{"task":"redirects"}`) for the exact supported alternative and the exact
validation error, or see [docs/OPEN-DECISIONS.md](../../docs/OPEN-DECISIONS.md).
