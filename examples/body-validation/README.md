# Body validation

Declares the shape of a JSON request body and two input formats in YAML, so a
route needs no hand-written validation code.

- `request.body` is keyed by method. `request.body.POST.schema` is a JSON
  Schema 2020-12 document in URLCode's bounded profile, compiled once at load. A body that breaks it answers **422**;
  malformed JSON is still 400 and a wrong media type 415.
- `/contacts` uses `$schema`, a local `#/$defs` reference, a nullable
  `type: [string, "null"]` and `anyOf`. A required `phone` must be present:
  `null` is accepted, an absent `phone` is not.
- `/requests` serves GET and POST on one path with different body rules.
  `GET: {maxBytes: 0}` refuses a GET body with 413, while POST requires a JSON
  body that matches its schema. See
  [per-method body rules](../../docs/HTTP.md#per-method-body-rules).
- Parameter `format: uuid` and `pattern` reject bad path and query values with 400.
- `pattern` must set `maxLength` (at most 128) and is refused when it repeats a
  group, uses lookaround or a backreference, has more than three unbounded
  quantifiers, or has more optional, bounded or alternative parts than its
  matching-cost budget allows. See [HTTP configuration](../../docs/HTTP.md).

The 422 answer is JSON whatever the `Accept` header, naming the first failure
the validator finds with its `pointer`, `keyword` and expected constraint,
never a value. An undeclared
property such as `extra` is named in `property` when it looks like an
identifier; see [HTTP](../../docs/HTTP.md#body-schema-and-input-patterns).
