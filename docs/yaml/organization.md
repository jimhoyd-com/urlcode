# YAML guide: Bindings, split files and tests

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 12. Environment and secret references

Route-level shape (references only, never secret values):

```yaml
    env:
      GREETING: {value: Hello}
      REGION: {env: APP_REGION}
    secrets:
      TOKEN: {secret: APP_TOKEN}
```

Literal non-secret env needs no grant. External env and secrets require an
operator-owned policy outside the checkout, granting exact names to the route
and pinning the reviewed config/code digest. `urlcode permissions --project
./my-links` prints a proposed policy; review it and store it outside the app.
Then pass `--policy /operator/path/policy.json` to validate/dev/test/serve.
This inspection does not authorize the project or execute its code.

Use ignored `.env.local` for local values; process environment wins. Production
`serve` reads process environment, never `.env.local`. Let your supervisor resolve
provider secrets and inject them; direct provider secret-store adapters do not
exist yet. Every config/code change invalidates the grant; rotate values by
restarting/redeploying. Never return a secret in an example response. Middleware
and functions on an approved route can read its bindings. See [policy setup](../FUNCTION-SECURITY.md).

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
