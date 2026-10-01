# Shared env and secret bindings

Copy it with `urlcode examples add shared-bindings --out shared-bindings`, then
from that directory:

```sh
urlcode test --project .
urlcode permissions --project .
urlcode explain /status --project .
```

Three routes need the same `SKILLS` and `REGION` bindings. Instead of repeating
them, the `skills` shared block declares them once and each route names it with
`use: skills`:

```yaml
shared:
  skills:
    env:
      SKILLS: {env: MCP_ENABLED_SKILLS, default: "search,summarize"}
      REGION: {value: eu-west-1}
```

The bindings are resolved into every route that names the block when the
project loads, so nothing about them becomes project-wide:

- `urlcode permissions` proposes `MCP_ENABLED_SKILLS` under `/skills`,
  `/skills/{name}` and `/status` separately. The operator still grants each
  route on its own, and a route left out of the policy falls back to the
  default (or, without one, refuses to activate).
- `urlcode explain <route>` lists each route's effective bindings by name,
  never by value.
- Adding a route to the block changes that route's requested grants and the
  project revision, so an operator policy pinned to the old revision is refused
  until it is reviewed again.

`/status` declares its own `REGION`; a route-level entry with the same name
wins, and `SKILLS` is still inherited. `secrets` work the same way
(`secrets: {KEY: {secret: api_key}}` in the block), each route requesting its
own grant; this example keeps to `env` so it runs without a policy. See
[shared blocks][docs/SPECIFICATION.md#shared-blocks] and
[bindings][docs/yaml/organization.md#12-environment-and-secret-references].

<!-- urlcode-current-version:start -->
[docs/SPECIFICATION.md#shared-blocks]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/SPECIFICATION.md#shared-blocks
[docs/yaml/organization.md#12-environment-and-secret-references]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.6/docs/yaml/organization.md#12-environment-and-secret-references
<!-- urlcode-current-version:end -->
