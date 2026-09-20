# Shared request and response.headers blocks

```sh
urlcode test --project examples/shared-blocks
urlcode routes --project examples/shared-blocks
```

`shared` names reusable `request` and `response.headers` blocks; a route picks
one with `use`. `/orders/preview` overrides `request` and keeps the shared
headers; `/health` overrides `response` and drops the shared headers. `routes`
prints the resolved result. See [the specification](../../docs/SPECIFICATION.md).
