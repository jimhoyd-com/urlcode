# Local recipes

Recipes are ordinary version-controlled URLCode projects shipped with the
runtime. There is no network registry, install script, provider account or
project-code execution during authoring.

```sh
urlcode recipes list
urlcode recipes show redirect
urlcode recipes add redirect --out ./documentation-redirect --dry-run
urlcode recipes add redirect --out ./documentation-redirect
urlcode validate --local --project ./documentation-redirect
```

The catalog includes `redirect` (explicit query passthrough), `json-api`
(bounded JSON request and a sandboxed echo function), and `typescript`
(build-time typed guest authoring). Each recipe contains a README and editable
files. Replace example destinations and review the resulting files before use.
The TypeScript recipe requires the build step described in
[TypeScript authoring](TYPESCRIPT-AUTHORING.md).

`add` creates a new standalone directory. It refuses an existing destination,
even an empty directory; it never merges or overwrites existing project routes.
Review or copy selected declarations manually when combining projects. Dry-run
reads and validates the packaged recipe and checks the destination, but writes
nothing. The output parent must already exist and be owned by the caller.
Dependencies are written first and the complete `urlcode.yaml` is published by
rename last. A failed write removes the new directory. This is atomic project
activation, not an atomic directory replacement or a guarantee against a local
attacker concurrently replacing the caller's output directories.

The SDK provides `listRecipes()`, `showRecipe(name)` and
`addRecipe(name, output, {dryRun})`. Catalog metadata and file lists are returned
as copies. Unknown names and arbitrary paths/URLs fail closed. The catalog
uses the same schema as ordinary projects and integration tests run each recipe
through the real runtime (after building the TypeScript recipe).
