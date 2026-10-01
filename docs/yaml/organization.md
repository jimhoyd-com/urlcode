# YAML guide: Bindings, split files and tests

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 12. Environment and secret references

Route-level shape (references only, never secret values):

```yaml
    env:
      GREETING: {value: Hello}
      REGION: {env: APP_REGION}
      DATA_FILE: {env: DATA_FILE, default: default-data.json}
    secrets:
      TOKEN: {secret: APP_TOKEN}
```

Literal non-secret env needs no grant. External env and secrets require an
operator-owned policy outside the checkout, granting exact names to the route
and pinning the reviewed config/code digest. `urlcode permissions --project
./my-links` prints a proposed policy; review it and store it outside the app.
Then pass `--policy /operator/path/policy.json` to validate/dev/test/serve.
This inspection does not authorize the project or execute its code.

`DATA_FILE` above declares `env` with a `default`: a value the project ships
with, overridden at request time when the process has a non-empty `DATA_FILE`
environment variable *and* the operator has granted this route that name.
This is the sanctioned way to point a route at a different value per
deployment or test run without editing YAML or bypassing the binding model by
reading `process.env` from function code. Unlike an `env`-only binding with no
`default`, an ungranted `DATA_FILE` here does not fail activation — it just
falls back to `default` and the host is never read, so the project still
works with no operator policy at all until one opts in to overriding it. A
plain `{value: ...}` literal (like `GREETING` above) never combines with
`env`: it always stays exactly the reviewable literal it declares, with no
grant and no possible host override.

**Shared bindings.** When several routes need the same bindings, declare them
once in a top-level `shared` block (entry `urlcode.yaml` only) and name it
with `use`:

```yaml
version: "1"
shared:
  skills:
    env:
      SKILLS: {env: MCP_ENABLED_SKILLS}
      REGION: {value: eu-west-1}
    secrets:
      KEY: {secret: skills_api_key}
routes:
  /skills:
    use: skills
    function: functions/skills.mjs
  /status:
    use: skills
    env:
      REGION: {value: us-east-1}   # the route's own entry wins by name
    function: {source: functions/skills.mjs, export: status}
```

The block's `env` and `secrets` merge name by name into each route that uses
it, the route's own entry winning. They are resolved when the project loads,
so `urlcode permissions` proposes the grants under each route separately, the
operator grants each route on its own, and `urlcode explain` lists each
route's effective bindings (names only). A shared block grants nothing and is
not project-wide. Adding a route to a block changes that route's requested
grants and the project revision, so the old policy's pin is refused until it
is reviewed. See [shared blocks](../SPECIFICATION.md#shared-blocks) and the
runnable [`examples/shared-bindings`](../../examples/shared-bindings/README.md).

Use ignored `.env.local` for local values; process environment wins. Production
`serve` reads process environment, never `.env.local`. Let your supervisor resolve
provider secrets and inject them; direct provider secret-store adapters do not
exist yet. Every config/code change invalidates the grant; rotate values by
restarting/redeploying. Never return a secret in an example response. Middleware
and functions on an approved route can read its bindings. See [policy setup](../FUNCTION-SECURITY.md).

**Data-directory pattern.** A function that reads files from a directory the
host should choose (a per-test fixture set, a mounted volume) declares
`DATA_DIR: {env: DATA_DIR}` and reads `env.DATA_DIR` from its context instead of
`process.env`, so the binding shows in `permissions` and `audit`. With no
`default`, an ungranted binding or an unset `DATA_DIR` refuses to activate. To
give the same binding a project-shipped default that works with no operator
policy at all, and that a host can still opt in to overriding later, add a
`default` — `DATA_DIR: {env: DATA_DIR, default: ./data}` — which falls back
to that default whenever the grant is missing or the variable happens not to
be set, rather than refusing activation. Either way a host cannot silently
override a `{value}`-only binding: only a binding that declares `env` can
ever be overridden, and only for the exact granted name. Validate any
request-supplied file name before joining it to the directory. The runnable
[`examples/data-dir`](../../examples/data-dir/README.md) project is validated,
tested and audited with a policy outside the checkout.

## 13. Split files and folders

Complete entry point:

```yaml
version: "1"
includes:
  - routes/code.yaml
  - routes/marketing/links.yaml
routes: {}
```

Each included file contains `version: "1"` and `routes`. No nested includes,
globs, anchors, merge keys or remote includes. References always use project-root
paths. Duplicate routes fail; include order is not priority. See [organization](../ORGANIZATION.md)
and [matching/regex/wildcard rules](../ROUTING.md).

## 14. Assert inputs and outputs

Save a JSON array as `tests/requests.json`:

```json
[
  {"path":"/hello/Ada","status":200,"expectBody":"{\"message\":\"Hello, Ada!\"}"},
  {"path":"/hello/Ada","method":"HEAD","status":200,"expectBody":""},
  {"path":"/go","status":302,"expectHeaders":{"location":"https://example.com/"}},
  {"path":"/go","method":"POST","status":405,"expectHeaders":{"allow":"GET, HEAD"}}
]
```

This fixture targets recipes 1 and 2 together; the runnable cookbook has its own
matching expectations. Supported test fields: `path`, optional `method`, request
`headers` and string `body`, required `status`, optional exact string `expectBody`
and string-map `expectHeaders`. Tests do not follow external redirects. There
are no route-local YAML test fields or JSON-path assertions yet.

Run validate, test, routes, and audit with an intentional expected count. Test
both positive and negative inputs, every allowed method, HEAD, middleware short
circuits and relevant asset conditions. Audit needs meaningful body/header
assertions; a status-only success is insufficient. Benchmarks and recovery drills
are separate from functional correctness. See [readiness](../READINESS.md).

See [organization and readability practices](../BEST-PRACTICES.md) for conventions
that keep larger projects easy to maintain.
