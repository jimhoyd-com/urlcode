# Body validation

Declares the shape of a JSON request body and two input formats in YAML, so a
route needs no hand-written validation code.

- `request.body` is keyed by method. `request.body.POST.schema` is a JSON
  Schema 2020-12 document in URLCode's bounded profile, compiled once at load. A body that breaks it answers **422**;
  malformed JSON is still 400 and a wrong media type 415.
- `/contacts` uses `$schema`, a local `#/$defs` reference, a nullable
  `type: [string, "null"]`, `anyOf` and the standard `format: email` and
  `format: date-time`. A required `phone` must be present:
  `null` is accepted, an absent `phone` is not.
- `/requests` serves GET and POST on one path with different body rules.
  `GET: {maxBytes: 0}` refuses a GET body with 413, while POST requires a JSON
  body that matches its schema. See
  [per-method body rules][docs/HTTP.md#per-method-body-rules].
- `/leads` and `/referrals` name one schema, `lead`, declared under the
  top-level `schemas:` map as `{file: schemas/lead.json}`. That file is an
  ordinary JSON Schema 2020-12 document with relative `$ref`s to
  `contact-point.yaml` (the whole file, and its `$defs/source` entry); they are
  read offline and bundled when the project loads, and a remote or escaping
  reference would refuse the load. Both routes run one validator and answer the
  same 422, and the OpenAPI export writes `lead` once as a component. An mcp
  tool can name the same schema. See
  [named schemas][docs/HTTP.md#named-schemas].
- Parameter `format: uuid` and `pattern` reject bad path and query values with 400.
- `pattern` must set `maxLength` (at most 128) and is refused when it repeats a
  group, uses lookaround or a backreference, has more than three unbounded
  quantifiers, or has more optional, bounded or alternative parts than its
  matching-cost budget allows. See [HTTP configuration][docs/HTTP.md].

The 422 answer is JSON whatever the `Accept` header, naming the first failure
the validator finds with its `pointer`, `keyword` and expected constraint,
never a value. An undeclared
property such as `extra` is named in `property` when it looks like an
identifier; see [HTTP][docs/HTTP.md#body-schema-and-input-patterns].

<!-- urlcode-current-version:start -->
[docs/HTTP.md#per-method-body-rules]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#per-method-body-rules
[docs/HTTP.md#named-schemas]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#named-schemas
[docs/HTTP.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md
[docs/HTTP.md#body-schema-and-input-patterns]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/HTTP.md#body-schema-and-input-patterns
<!-- urlcode-current-version:end -->
