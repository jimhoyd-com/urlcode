# Body validation

Declares the shape of a JSON request body and two input formats in YAML, so a
route needs no hand-written validation code.

- `request.body.schema` accepts a small JSON Schema subset. A body that breaks it
  answers **422**; malformed JSON is still 400 and a wrong media type 415.
- Parameter `format: uuid` and `pattern` reject bad path and query values with 400.
- `pattern` must set `maxLength` (at most 128) and is refused when it repeats a
  group, uses lookaround or a backreference, or has more than three unbounded
  quantifiers. See [HTTP configuration](../../docs/HTTP.md).

The 422 answer is JSON whatever the `Accept` header, listing every failure with
its `pointer`, `keyword` and expected constraint, never a value. An undeclared
property such as `extra` is named in `property` when it looks like an
identifier; see [HTTP](../../docs/HTTP.md#body-schema-and-input-patterns).
