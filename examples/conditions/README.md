# Exact routing conditions

Run the executable fixture with the operator-owned public origin:

```sh
urlcode test --project examples/conditions --origin https://conditions.example.test
```

The 11 requests cover disjoint campaign cases, fallback, header/cookie guards,
duplicate rejection, HEAD and trusted-origin matching. All data is synthetic.
Conditions compare request inputs; they do not authorize users or grant guest
capabilities. See [the condition contract](../../docs/CONDITIONS.md).
