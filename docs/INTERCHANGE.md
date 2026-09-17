# Redirect interchange and bulk authoring

`importRoutes` and `exportRoutes` return a conversion report without writing files,
activating a runtime, reading bindings, loading function sources or running code.
The CLI can preview the report before creating a new output file. Failed reports
never contain a partial document or output; duplicate paths never overwrite a row.

```js
import { importRoutes, exportRoutes } from '@jimhoyd/urlcode';
const report = await importRoutes({
  format: 'csv', source: 'migration.csv',
  text: 'path,url,status\n/old,https://example.test/new,301\n'
});
if (!report.ok) throw new Error(JSON.stringify(report.diagnostics));
// report.output is URLCode project YAML; report.document is the validated project.
const csv = await exportRoutes({ format: 'csv', document: report.document });
```

Each report has `ok`, `lossless`, `routeCount` and `diagnostics`. Diagnostics name
an input source, physical CSV/text row or JSON/YAML array index where available,
a path where appropriate, a code, severity and explanation. Destinations and
credentials are not echoed in validation errors. Output is sorted by literal
path, independent of input order. Import does not merge an existing project;
normal project loading rejects collisions across includes when output is added.

## CLI usage

```sh
# Bulk row formats can be inferred from the input extension or named explicitly.
urlcode import csv migration.csv --out routes.yaml --dry-run
urlcode import csv migration.csv --out routes.yaml
urlcode import migration.json --report json --dry-run

# Provider migrations require explicit acknowledgment of the reported differences.
urlcode import netlify _redirects --out imported.yaml --dry-run
urlcode import netlify _redirects --out imported.yaml --accept-provider-differences
urlcode export --target netlify --project ./project --out _redirects --accept-provider-differences
urlcode export --target cloudflare --project ./project --dry-run
urlcode export --target vercel --project ./project --dry-run
urlcode export --target netlify-toml --project ./project --dry-run
```

General import syntax is `urlcode import [format] FILE`; `--format` explicitly
overrides the positional format or extension. Exports use `--target` for a
provider format, or `--format csv|json|yaml` for row data. `--out FILE` creates a
new file with mode 0600 and never overwrites one. `--dry-run` validates and
returns a report without creating the requested output. `--report json` always
emits the report. Failures exit nonzero and leave no converted output.

Reports include source/row diagnostics and the successful candidate output.
Acknowledged provider conversions always emit a report with their warnings,
even when `--out` is provided; raw provider output is never silently printed as
if it were lossless. Project export flattens validated includes, but refuses
other unsupported project behavior instead of dropping it. For a large input
that needs a complete sharded project, use [bulk import](BULK.md).

## Supported forms

| Format | Input/output subset |
| --- | --- |
| `csv` | Header exactly `path,url,status`; optional empty status defaults to 302; quoted fields and escaped quotes |
| `json` | Array of `{path,url,status?}`; status must be a number |
| `yaml` | The same row array in strict URLCode YAML syntax; not a full project file |
| `netlify` | `_redirects`: literal source, absolute HTTP(S) destination, optional status (default 301) |
| `cloudflare` | Pages `_redirects`: same columns, default 302; 2,000 static rules, 1,000 characters per rule |
| `vercel` | `vercel.json` containing only `redirects`; literal `source`, absolute `destination`, and either boolean `permanent` (308/307) or `statusCode` |
| `netlify-toml` | Only `[[redirects]]` blocks with `from`, `to`, optional numeric `status` (default 301); unescaped double-quoted strings |

All statuses are restricted to 301, 302, 303, 307 and 308. Literal ASCII paths
and absolute HTTP(S) destinations are required. The existing schema and semantic
compiler validate resulting routes. No provider pattern compiler is introduced.

The TOML subset deliberately rejects general TOML constructs, build settings,
escapes, inline comments, nested conditions, force flags and other tables. A full
`netlify.toml` must be separated into a redirects-only input by the operator. This
avoids silently discarding build settings or reinterpreting unsupported syntax.

Functions, assets, middleware, conditions, parameters, query maps/allowlists,
headers, policies, includes and any other extra route/project fields cannot be
exported by this subset. Relative destinations, wildcards, provider placeholder
syntax, rewrites and duplicate paths fail. Use a runtime adapter for richer
behavior. CSV/JSON/YAML round-trips are lossless within the declared simple subset.

## Provider semantics require explicit acknowledgment

Provider conversions fail by default. `acceptProviderDifferences: true` (CLI
`--accept-provider-differences`) permits a **non-lossless migration candidate**;
it does not suppress invalid rules, discard unsupported fields or claim exact
behavior. Every such successful report retains a warning and `lossless: false`.

URLCode drops incoming query parameters and defaults to GET/HEAD. Native
redirect systems can apply to other methods and have different normalization
and request-query behavior. Netlify automatically forwards queries for common
redirect statuses and can give existing files precedence. Cloudflare Pages
redirects override assets, but Pages Functions can bypass `_redirects`.
Review behavior for requests with queries, non-GET methods, slash/URL normalization
and conflicting assets/functions before deploying. The acknowledged subset is
literal GET/HEAD requests without these conflicts. No provider deployment was
performed as part of interchange unit tests.

Provider references checked 2026-09-17:

- [Netlify redirect options](https://docs.netlify.com/manage/routing/redirects/redirect-options/)
- [Netlify TOML configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/)
- [Cloudflare Pages redirects](https://developers.cloudflare.com/pages/configuration/redirects/)
- [Vercel redirect configuration](https://vercel.com/docs/project-configuration/vercel-json)

## Resource limits

Imports reject more than 32 MiB of input or 100,000 rows. Diagnostic collection
stops after 100 invalid rows; normal route compilation retains its deadline and
validation rules. Large output can still exceed the runtime YAML worker's heap
or deadline: conversion success does not promise activation of a single 100k
route YAML file. Split large migration inputs into independently reviewed files
and use explicit `includes`; aggregate project limits continue to apply.

Reports also expose bounded classification counts:

- `convertedRoutes`: routes actually returned in successful output; zero when
  any error prevents output.
- `nativeEquivalentRoutes`: returned routes with no conversion warnings; always
  zero for acknowledged provider conversions.
- `runtimeRequiredRoutes`: route diagnostics identifying behavior outside the
  simple export subset.
- `unsupportedRows`: known invalid/duplicate input-row diagnostics.
- `providerDifferenceRoutes`: candidate routes subject to the provider semantic
  warning; these overlap converted routes after acknowledgment.
- `fullyScanned`: false on parser/global failures or truncated diagnostics. Counts
  then describe only examined input, never an inferred total.

These counts are not a partition of arbitrary malformed input. `routeCount`
retains its original meaning: routes in the candidate table, or rows
parsed before an early global failure. A failed report contains no candidate
output even if some rows were convertible.
