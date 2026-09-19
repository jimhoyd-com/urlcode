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
| `/assets/*` with a `static` handler | Files under `/assets/`, including `/assets/css/site.css` | `/assets`, `/assets-other/site.css` |

A `{parameter}` captures exactly one nonempty path segment. It is **not greedy**:
it cannot consume slashes or the rest of a URL. Declare each path parameter as a
required string in `parameters`. Encoded slashes (`%2F`) and backslashes are
rejected, so encoding a slash cannot bypass this rule.

Only static directory handlers support `/*`, at the end of an otherwise literal
path. It covers the remaining nested file path; it is not a named capture or a
regex operator. Matching a mount does not guarantee a response file exists:
missing files return 404. It is not a catch-all for functions or redirects.

No regex routes, greedy parameters, optional segments, partial-segment parameters,
`**` globs, or regex constraints inside `{code}` are implemented. Characters such
as `.` and `+` have no regex meaning in a literal path. Do not paste a regex into
a route key: some regex-looking text is legal literal text, while unsupported
syntax may fail validation. Parameter-schema `pattern` is also unsupported.

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

Core has no native handler for this today: the `link` handler that implemented
it was removed. Stored short links are moving to a future
`urlcode-dynamic-link` extension package (mount-based, like `auth`/`admin`,
not yet published); a project needing them declares an `extension` mount once
that package exists.

Functions still cannot access databases, the filesystem or network directly.
General application state and realtime sessions remain future work.
