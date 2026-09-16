# Create placeholders from YAML

Write `urlcode.yaml` first, then generate its missing local references:

```sh
urlcode scaffold --project ./gitroll-link --dry-run
urlcode scaffold --project ./gitroll-link
urlcode validate --project ./gitroll-link --local
```

The project and entry YAML must already exist. `--dry-run` reports the same plan
without writing. Existing files are preserved byte-for-byte; the command never
adds exports to existing modules or overwrites implementations. Run it again after
adding declarations. No application code is executed and no credentials are read.

For example:

```yaml
version: "1"
routes:
  /hello:
    function:
      source: functions/hello.mjs
      export: handle
    middleware:
      - source: middleware/auth.mjs
  /about:
    page:
      file: public/about.html
  /assets/*:
    static:
      directory: public/assets
      index: index.html
```

This creates the two modules, an HTML page and the static directory/index.
Both modules return **501 Not implemented** until replaced. In particular, an
auth middleware placeholder does not silently allow requests through. Named
exports sharing a new module are combined; using the same export as both a
function and middleware is rejected as ambiguous. Configured arguments remain
in YAML for your implementation to use.

| Reference | Missing-file behavior |
|---|---|
| Included YAML | Creates `version: "1"` and empty routes; reports that definitions are still required |
| Function/middleware `.js` or `.mjs` | Creates requested exports returning 501 |
| Page/download `.html` or `.htm` | Creates a clearly labeled placeholder page |
| `.txt`, `.md`, `.csv`, `.css`, `.js`, `.mjs`, `.json` assets | Creates minimal placeholder text; JSON is `{}` |
| Static directory and configured index | Creates directories and index placeholder; cannot infer the rest of a site |
| PDF, image, archive or other asset | Reports unresolved; does not fabricate a corrupt binary file |
| Environment/secret references | Lists required external names; creates no values, policy grants or dotenv files |
| Link collection | Reports the required operator binding; creates no database or records |

All schema-valid route declarations, including disabled ones, are considered.
Existing included files are read; nested includes and duplicate routes fail.
Scaffolding checks schema and file safety, not complete routing semantics or
business correctness. Files use safe project-relative paths; traversal, hidden
paths, sensitive names, symlinks, hardlinked existing files and conflicting uses
are rejected. Keep the project operator-owned while writing. Planning errors
make no changes; an I/O failure while writing can leave some new placeholders,
which a subsequent run preserves. No transaction spans the whole filesystem.

After editing placeholders, run `validate`, add explicit response fixtures and
run `test` and `audit`. Validation catches missing modules/imports/exports/assets
and bindings. It does not prove that placeholder logic is complete. The report
always says `needsImplementation: true`; it is not a production-readiness gate.
Scaffolding does not recursively invent dependencies imported by existing code,
crawl HTML/CSS links, generate binary content, or implement your business logic.
See [readiness checks](READINESS.md) and [asset behavior](ASSETS.md).

Scaffolding enforces the entry-level `dynamicLinks` opt-in for `link` handlers
and reports the effective boolean. It never enables this capability for you.
