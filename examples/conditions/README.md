# Exact routing conditions

Copy it with `urlcode examples add conditions --out conditions` and run the
executable fixture from that directory with the operator-owned public origin:

```sh
urlcode test --project . --origin https://conditions.example.test
```

The 13 requests cover disjoint campaign cases, fallback, header/cookie guards,
duplicate rejection, HEAD and trusted-origin matching. All data is synthetic.
Conditions compare request inputs; they do not authorize users or grant guest
capabilities. See [the condition contract](../../docs/CONDITIONS.md).
