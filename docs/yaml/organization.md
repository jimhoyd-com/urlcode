# YAML guide: Bindings, split files and tests

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 12. Environment and secret references

Route-level shape (references only, never secret values):

```yaml
    env:
      GREETING: {value: Hello}
      REGION: {env: APP_REGION}
      DATA_FILE: {value: default-data.json, env: DATA_FILE}
    secrets:
      TOKEN: {secret: APP_TOKEN}
```

Literal non-secret env needs no grant. External env and secrets require an
operator-owned policy outside the checkout, granting exact names to the route
and pinning the reviewed config/code digest. `urlcode permissions --project
./my-links` prints a proposed policy; review it and store it outside the app.
Then pass `--policy /operator/path/policy.json` to validate/dev/test/serve.
This inspection does not authorize the project or execute its code.

`DATA_FILE` above declares both `value` and `env`: a default the project ships
with, overridden at request time when the process has a non-empty `DATA_FILE`
environment variable. This is the sanctioned way to point a route at a
different value per deployment or test run without editing YAML or bypassing
the binding model by reading `process.env` from function code. The grant
requirement is unchanged — the `env` name still needs `DATA_FILE` listed
under the route in the operator policy, exactly as an env-only binding would;
the default only covers the case where the grant exists but the host process
does not currently set the variable.

Use ignored `.env.local` for local values; process environment wins. Production
`serve` reads process environment, never `.env.local`. Let your supervisor resolve
provider secrets and inject them; direct provider secret-store adapters do not
exist yet. Every config/code change invalidates the grant; rotate values by
restarting/redeploying. Never return a secret in an example response. Middleware
and functions on an approved route can read its bindings. See [policy setup](../FUNCTION-SECURITY.md).

**Data-directory pattern.** A function that reads files from a directory the
host should choose (a per-test fixture set, a mounted volume) declares
`DATA_DIR: {env: DATA_DIR}` and reads `env.DATA_DIR` from its context instead of
`process.env`, so the binding shows in `permissions` and `audit`. With `env`
alone there is no default: an ungranted binding or an unset `DATA_DIR` refuses
to activate. To give the same binding a project-shipped default that a host can
still override per deployment or test run, declare both keys —
`DATA_DIR: {value: ./data, env: DATA_DIR}` — which still needs the same grant
but falls back to `value` when the grant exists and the variable happens not to
be set, rather than refusing activation. Either way a host cannot silently
override a `{value}`-only binding: only a binding that also declares `env` can
be overridden, and only for the exact granted name. Validate any
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
