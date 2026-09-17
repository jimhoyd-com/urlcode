# Organize routes your way

`urlcode.yaml` is the project entry point. The rest of the folder structure is
yours. Use one file for a few links or split routes by feature, team, campaign,
customer or another useful grouping. Folder names do not create URL prefixes.
Explicit file composition is already implemented; no new runtime mode is needed.

## One file

```yaml
# urlcode.yaml
version: "1"
routes:
  /go:
    redirect:
      url: https://example.com
```

## Multiple files and nested folders

The public [urlcode-template](https://github.com/jimhoyd-com/urlcode-template)
contains a function route and a redirect, organized like this:

```text
urlcode.yaml
routes/
  functions.yaml
  marketing/
    links.yaml
functions/
  hello.mjs
tests/
  requests.json
```

Entry point:

```yaml
# urlcode.yaml
version: "1"
includes:
  - routes/functions.yaml
  - routes/marketing/links.yaml
routes: {}
```

Function route:

```yaml
# routes/functions.yaml
version: "1"
routes:
  /hello:
    function:
      source: functions/hello.mjs
```

Function source for this short example:

```js
// functions/hello.mjs
export default function hello() {
  return Response.json({ message: "Hello!" });
}
```

Redirect route:

```yaml
# routes/marketing/links.yaml
version: "1"
routes:
  /go:
    redirect:
      url: https://example.com
```

These produce `/hello` and `/go`, not `/routes/hello` or `/marketing/go`. The
actual template adds a validated `{name}` input to the function example. You can
also colocate code with a feature, for example `features/support/routes.yaml`
and `features/support/hello.mjs`; use `source: features/support/hello.mjs`.

## Mix inline and included routes

Keep a few common routes in the entry point while splitting larger groups:

```yaml
version: "1"
includes:
  - routes/functions.yaml
  - routes/marketing/links.yaml
routes:
  /status:
    respond:
      json: {ok: true}
```

With the example files above, the combined project has three routes. Update your
reviewed `--expect-routes` count when adding/removing a route. Simply moving a
route between files does not change the count or its URL.

## Composition rules

- All file references are relative to the project root containing `urlcode.yaml`,
  including `includes`, function `source`, and asset `file`/`directory` references.
  They are never relative to the included YAML file.
- Each file declares `version: "1"` and `routes`. The entry point uses `routes: {}`
  when all routes live in includes. `.yaml` and `.yml` work.
- Includes list explicit files, including paths through nested folders. There is
  no directory auto-discovery, glob expansion or remote configuration download.
- Put all includes in `urlcode.yaml`; included files cannot include other files.
- Duplicate files or route paths fail validation. Include order does not provide
  overrides or change route-matching precedence.
- References must stay inside the project. Missing files and escaping symlinks
  fail validation. Do not use secret files as configuration.
- Current limits: 256 included files, 32 MiB per YAML file, 64 MiB aggregate YAML and 100,000 total routes. Parser-worker and compilation limits also apply; see [capacity](CAPACITY.md).
  These limits apply to the combined project, not separately per folder.

`dev` reloads changes to ordinary project YAML files and keeps the last valid
snapshot if a change is invalid. Configuration in hidden/build/dependency
folders or behind symlink targets is outside the normal watcher: use ordinary
source folders or restart after such changes. File grouping does not weaken
function isolation or operator binding requirements.

`validate`, `routes`, `test`, `audit` and `benchmark` all use the same merged
project. To move files safely: edit the include list and any changed project-root
references, validate, then run the audit with the same expected count. Paths
inside a moved route file need no change when their target files remain in place.
See the [implemented contract](SPECIFICATION.md) and [readiness guide](READINESS.md).

See [route matching and new links](ROUTING.md) for parameter/wildcard semantics,
priority rules and activation of newly added definitions.

For layout choices, naming, readable YAML/functions, middleware responsibilities
and safe refactoring, see [organization and readability practices](BEST-PRACTICES.md).
