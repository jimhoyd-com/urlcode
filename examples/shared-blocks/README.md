# Shared request and response.headers blocks

Copy it with `urlcode examples add shared-blocks --out shared-blocks`, then from that directory:

```sh
urlcode test --project .
urlcode routes --project .
```

`shared` names reusable `request` and `response.headers` blocks; a route picks
one with `use`. `/orders/preview` overrides `request` and keeps the shared
headers; `/health` overrides `response` and drops the shared headers. `routes`
prints the resolved result. See [the specification](../../docs/SPECIFICATION.md).
