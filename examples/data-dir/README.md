# Data directory example

A trusted function that reads files from a directory the operator picks. The
project declares only the *name* `DATA_DIR`; the host supplies the value, so a
test run, a benchmark or a deployment can point the same reviewed project at a
different directory without copying it.

```yaml
routes:
  /notes/{name}:
    function: functions/note.mjs
    env:
      DATA_DIR: {env: DATA_DIR}
```

The function receives the resolved value as `env.DATA_DIR` in its second
argument. It does not read `process.env`, so the binding stays visible to
`permissions` and `audit`. Validate the request-supplied file name before
joining it to the directory; the function does that with an allowlist pattern.

There is no default: a binding the operator did not grant, or a `DATA_DIR` that
is not set, refuses to activate rather than falling back to a directory the
project chose. Use `{value: ...}` only for a fixed literal.

Run it from the runtime checkout. The policy lives outside the project, and the
`--policy` file must be regenerated whenever the config or function changes:

```sh
urlcode permissions --project examples/data-dir > /path/outside/project/policy.json
export DATA_DIR=./examples/data-dir/data        # relative paths resolve from the process working directory
urlcode validate --local --project examples/data-dir --policy /path/outside/project/policy.json
urlcode test --project examples/data-dir --policy /path/outside/project/policy.json
urlcode audit --project examples/data-dir --expect-routes 1 --policy /path/outside/project/policy.json
```

For local development, `DATA_DIR=...` may live in an ignored `.env.local`;
production `serve` reads only the process environment. See
[bindings](../../docs/yaml/organization.md#12-environment-and-secret-references)
and [policy setup](../../docs/FUNCTION-SECURITY.md).
