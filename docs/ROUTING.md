# Route matching

## Supported path patterns

URLCode matches paths, not regular expressions. Matching is case-sensitive and
covers the whole path; trailing slashes are significant. Query strings are inputs,
not part of the route key.

| Route key | Matches | Does not match |
|---|---|---|
| `/go` | `/go`, `/go?campaign=spring` | `/Go`, `/go/`, `/go/extra` |
| `/r/{code}` | `/r/abc`, `/r/123` | `/r/`, `/r/abc/extra` |
| `/r/{code}/details` | `/r/abc/details` | `/r/abc/other/details` |
| `/legacy/**` with a `redirect` handler | `/legacy/a`, `/legacy/a/b/c` | `/legacy`, `/legacy/`, `/legacy/a//b` |
| `/assets/*` with a `static` handler | Files under `/assets/`, including `/assets/css/site.css` | `/assets`, `/assets-other/site.css` |

A `{parameter}` captures exactly one nonempty path segment. It is **not greedy**:
it cannot consume slashes or the rest of a URL. Declare each path parameter as a
required string in `parameters`. Encoded slashes (`%2F`) and backslashes are
rejected, so encoding a slash cannot bypass this rule.

Only static directory handlers support `/*`, at the end of an otherwise literal
path. It covers the remaining nested file path; it is not a named capture or a
regex operator. Matching a mount does not guarantee a response file exists:
missing files return 404. It is not a catch-all for functions or redirects.

A `redirect` handler alone supports a terminal `/**` after a literal prefix (never bare `/**`, never
with a `{parameter}`). It matches one or more remaining segments, and `{**}` in `redirect.url` is
those segments, each percent-encoded and joined by `/`, usable once and only in the destination
path. Empty segments, `.`/`..`, encoded slashes and captures over 1,024 characters do not match.
Exact and `{parameter}` routes always win over it, so `/legacy/keep/{id}` can carve an exception out
of `/legacy/**`. It is refused on static hosting (S3 redirects match one path) and on Cloudflare
until the Worker table supports suffix matching, and it cannot share a prefix with a `static` mount.

No regex routes, greedy parameters, optional segments, partial-segment parameters,
other `**` globs, or regex constraints inside `{code}` are implemented. Characters such
as `.` and `+` have no regex meaning in a literal path. Do not paste a regex into
a route key: some regex-looking text is legal literal text, while unsupported
syntax may fail validation. To constrain a segment's value, declare a bounded
`pattern` or `format: uuid` in its parameter schema instead
([inputs](SPECIFICATION.md#inputs)); a value that does not match returns 400.

## Precedence and ambiguity

1. An exact literal route wins.
2. A parameterized route wins next; more literal segments means higher priority.
3. Static mounts follow; the longest matching mount prefix wins.

YAML order and include-file order do not decide priority. For example, `/r/help`
wins over `/r/{code}`. Among parameter routes, `/r/fixed/{item}` wins over
`/r/{group}/{item}` for `/r/fixed/book`. The latter still handles `/r/team/book`.

Equally specific overlapping parameter routes fail configuration validation.
For example, `/r/{code}` and `/r/{name}` conflict, as do `/a/{x}` and `/{y}/b`.
Disjoint patterns with equal specificity are allowed. Duplicate exact route keys
also fail, including duplicates across included files.

Selection happens before method, enabled/expiry and input validation. A selected
route returning 405, 404, 410 or 400 does not fall through to another route.
Likewise, a missing file in the longest selected static mount does not fall back
to a shorter mount. See [HTTP](HTTP.md) and [the contract](SPECIFICATION.md).

## Adding a configured redirect today

```sh
urlcode add https://example.com/new-page --alias new-link --project ./my-links
```

This validates and writes `/new-link` to the project's `urlcode.yaml`. It is a
local authoring command, not a live route-registration API. It does not commit
to Git or contact a running server. Commit/review the resulting definition as
part of your normal deployment workflow.

| Running mode | How new YAML routes become active |
|---|---|
| `urlcode dev` | Watches ordinary project files about every 500 ms, builds and validates a complete replacement snapshot, then swaps it in without restarting the HTTP server |
| `urlcode serve` | Fixed snapshot; restart/redeploy to activate configuration changes |
| Embedded server API | The returned server exposes `await app.reload()` for an explicit full snapshot replacement; this is not an HTTP admin endpoint |

Reload is a full configuration/source/asset snapshot rebuild, not an incremental
single-route insertion. Existing requests finish on the old snapshot; new
requests use the replacement once it is ready. An invalid candidate leaves the
previous snapshot serving. Watcher exclusions and binding-policy rules still
apply: configuration changes invalidate revision-pinned external binding grants.
See [reload details](SPECIFICATION.md#reload-and-status) and
[operator policy](FUNCTION-SECURITY.md).

## A TinyURL-style service: application data versus route definitions

For a service where visitors constantly create short links, the intended design
is one stable route such as `/r/{code}` plus a lookup of `code -> destination` in
application-owned persistent data. A new short code then changes data, not YAML,
and needs no route rebuild or service restart. The same distinction applies to
any per-visitor session record. Git owns route behavior and code; user-created records have
their own persistence, backup and export lifecycle.

Core has no native handler for this: the `link` handler that implemented it was
removed, and the `urlcode-dynamic-link` package that replaced it is retired.
The operator-installed `store` extension now covers it declaratively through
`extensions.store.config.shortLinks`; see [data store](STORE.md).

A trusted function runs in Node and could reach a database itself, but that
makes the project own the storage; a `sandbox: true` function cannot reach
databases, the filesystem or the network at all.
General application state and realtime sessions remain future work.
