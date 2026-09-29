# OpenAPI 3.1 schema

`oas-3.1-schema-2025-09-15.json` is the official JSON Schema for OpenAPI 3.1
documents published by the OpenAPI Initiative, copied unchanged from
<https://spec.openapis.org/oas/3.1/schema/2025-09-15> (its `$id`). It is
licensed under the Apache License 2.0, like the
[OpenAPI Specification repository](https://github.com/OAI/OpenAPI-Specification)
it comes from; the root `NOTICE` records the attribution. It ships in the core
package.

`urlcode openapi --check` (`packages/core/src/openapi-check.ts`) validates a
document against it with Ajv's JSON Schema 2020-12 validator, and the
repository's export tests (`test/openapi-contract.ts`) run the same check. That
schema checks the document's structure, not its Schema Objects (it is the
variant "without Schema Object validation"), so the check also validates every
Schema Object against the JSON Schema 2020-12 meta-schema and resolves every
local `$ref`. Ajv resolves the file's `$dynamicRef: "#meta"` against the wrong
dynamic scope; the check replaces it with the static `$ref: "#/$defs/schema"`
when it loads the file, which is equivalent here because `$defs/schema` holds
the file's only `$dynamicAnchor: meta`. Formats are not checked.

To update it, download a newer dated iteration from the same address, keep the
file byte-for-byte, and change the file name and `officialOpenApiSchema` in
`openapi-check.ts`, and the file name in `NOTICE` and `scripts/package-smoke.ts`.
