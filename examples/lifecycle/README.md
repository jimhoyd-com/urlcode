# Create, read, update, restart

One ordered fixture in `tests/requests.json` walks a note through its whole life.
Copy it with `urlcode examples add lifecycle --out lifecycle`, then from that directory:

```sh
urlcode test --project .
```

The fixture is a `steps` list. The POST captures the new note's `id` (from the JSON
body) and its `Location` (from a header); later steps use them as `{{id}}` and
`{{where}}`. The `{"restart": true}` step closes the runtime and starts it again on
the same project and data directory, so the last request proves the note survived.
The function keeps notes under `URLCODE_DATA_DIR`, which `urlcode test` points at a
fresh temporary directory for each run. All data is synthetic. See the
[fixture reference](../../docs/READINESS.md#multi-step-fixtures).
