# Dynamic links: Setup: requirements, YAML and the example

Part of [dynamic links](../DYNAMIC-LINKS.md), which indexes every page.

## Node build requirement

Live links need a Node build carrying the patched SQLite WAL fix: SQLite 3.51.3
or newer, 3.50.7 or 3.44.6. Node bundles SQLite, so this is a property of the
build, not something you can install separately, and some current releases on a
supported Node line ship an unpatched version. Run `urlcode doctor` and check
`liveLinks`; activation fails closed and names the detected version when the
build is unsuitable. Everything except live links works on any supported Node.

Available in URLCode 0.1.0. Define a stable route once; create, update and delete
short-code records while `serve` keeps running. No YAML rewrite, route snapshot
rebuild, Git commit or public-server restart is needed for record changes.

This first adapter uses optional SQLite storage on one host. Multiple processes
on that host can share it. No database is required for ordinary YAML-defined
routes. Network filesystems, multi-host replication and serverless ephemeral disks
are not supported by this adapter. SQLite WAL requires processes on the same
host; see [SQLite WAL](https://www.sqlite.org/wal.html).

## Behavior in YAML, data outside Git

```yaml
version: "1"
dynamicLinks: true
routes:
  /r/{code}:
    parameters:
      - name: code
        in: path
        required: true
        schema: {type: string, minLength: 1, maxLength: 128}
    link:
      collection: links
      code: {from: path, name: code}
```

`link` is a seventh primary handler, exclusive with `function`, `redirect`,
`respond`, `page`, `static` and `download`. Its `code` is a declared path-input
reference. `collection` is a logical name, not a filesystem path. GET and HEAD
are supported; normal route precedence, lifecycle and input validation apply.
An exact YAML route can intentionally shadow a stored code's URL.

The operator binds `links` to a database outside the project. YAML cannot choose
a database file or grant itself storage. The built-in public binding opens it
read-only. It performs an indexed database lookup for each request, with no
application cache or negative cache. Requests starting after an acknowledged
mutation can see it immediately; an already-running request can finish with an
older result. Browser/proxy caches remain outside that guarantee.

Missing or disabled record: 404. Expired record: 410. Unavailable/overloaded
store: 503. Invalid code syntax: 404 after route input validation. Redirects
default to 302 and no-store. Query strings are not forwarded. A record's URL is
literal HTTP(S), with no embedded credentials, control characters or interpolation.
It is a redirect, not a server-side fetch. The store does not verify destination
ownership, safety or availability; application abuse prevention remains necessary.

## Run the included example

From the runtime checkout, choose a private data directory **outside the app**.
Its parent directory must already exist. The following POSIX-shell example uses
an operator-created directory; on Windows use an absolute local drive path.

```sh
mkdir -p ../urlcode-data
URLCODE_DATA="$(cd ../urlcode-data && pwd)"
node src/cli.ts links init --store "$URLCODE_DATA/links.sqlite"
node src/cli.ts links create --store "$URLCODE_DATA/links.sqlite" \
  --code demo --destination https://example.com/demo
node src/cli.ts serve --project examples/live-links \
  --link-store "links=$URLCODE_DATA/links.sqlite" --port 3000
```

Open `/r/demo`. In a second terminal, run another `links create` with an unused
code against the same absolute file; its URL works immediately. Omit `--code`
to generate a cryptographically random 16-character base64url code. Codes allow
1–128 letters, digits, underscores and hyphens; collection names begin with a
letter and contain at most 64 letters/digits/underscores/hyphens.

The CLI defaults to collection `links`; specify `--collection` to manage another.
Serving currently accepts one `--link-store collection=/absolute/file` binding;
embedded applications may supply multiple adapters. Commands do not copy records
into YAML or create route definitions automatically.

## Explicit project opt-in

Only the entry `urlcode.yaml` may set `dynamicLinks: true`. It defaults to false;
the starter writes `dynamicLinks: false` explicitly. Included route files cannot
set or override it. Any `link` handler, including a disabled route, or runtime
link-store binding requires the opt-in. This flag means live stored-link records,
not parameterized redirects, custom functions, middleware or development reload.

`validate`, `routes`, `audit` and `scaffold` reports expose `dynamicLinks` as a
boolean. Enabling it grants no storage access to guest code and starts no
management endpoint. The operator still supplies the external store binding;
management remains a separate authenticated service. Standalone `links` CRUD/API
commands operate the operator's store independently of this public-runtime flag.

Migration: existing live-link projects must add `dynamicLinks: true` to their
entry file. Refresh revision-pinned function policies for those projects using
the normal operator review flow; enabling the capability changes the approval
digest. Projects that omit it or explicitly set false retain their prior digest.
To disable, remove `link` declarations and serving-store bindings, then set false
and validate/redeploy. Editing the flag alone does not stop an already running
production process or management API. Invalid reloads retain the last-good state.

## Middleware, sandbox and tests

Middleware may wrap a successful link response; the usual native metadata/body
rules apply. Lookup/missing/disabled/expiry errors happen before middleware. The
handler does not make database objects available to guest code. Functions still
have no filesystem, SQL, fetch, storage broker or management token capability.
Link changes do not alter configuration/source digests or invalidate unrelated
function-binding grants. Changing YAML still does.

`routes` and `audit --expect-routes` count definitions, not stored records. Link
routes require explicit successful GET/HEAD fixtures; there is no assumed fixture
for live data. Seed a disposable test database, then pass `--link-store` to
validate/test/audit/benchmark. Do not run mutation tests against production.

```sh
node src/cli.ts test --project examples/live-links --link-store links=/absolute/test-links.sqlite
node src/cli.ts audit --project examples/live-links --link-store links=/absolute/test-links.sqlite --expect-routes 2
```

The example expects `demo -> https://example.com/demo` and an unused `not-created`
code. Tests cover create/update/delete visibility without reload, persistence,
concurrent conflicts, expiry/disabled semantics, scope, public/admin separation,
body/token boundaries, overload and acknowledged writes after abrupt writer exit.
Production durability, sustained load and recovery drills still require validation
on your actual storage. General application state, WebRTC sessions, user-account
APIs and arbitrary runtime code registration remain separate future work.
