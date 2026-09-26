# Local recipes

Recipes are ordinary version-controlled URLCode projects shipped with the
runtime. There is no network registry, install script, provider account or
project-code execution during authoring. Search them before writing a common
route by hand: the catalog is the vocabulary of behavior the runtime already
supports, and every recipe validates, tests and audits.

```sh
urlcode recipes list
urlcode recipes search "webhook json"        # id, description, tags, capabilities
urlcode recipes search webhook --json
urlcode recipes show webhook-receiver        # metadata first, then every file
urlcode recipes add webhook-receiver --out ./orders-hook --dry-run
urlcode recipes add webhook-receiver --out ./orders-hook
urlcode validate --local --project ./orders-hook
```

## The catalog

| Recipe | Complexity | What it shows | Needs |
|---|---|---|---|
| `redirect` | starter | Permanent redirect forwarding one allowlisted query key | nothing |
| `health-page` | starter | Native `/health` text and `/status` JSON, no-store | nothing |
| `static-page` | starter | One HTML file served natively as a page | nothing |
| `json-endpoint` | starter | POST fields validated by `request.body.schema`, answers from `respond`, no project code | nothing |
| `json-api` | starter | Bounded JSON body echoed by a trusted function | self-hosted runtime |
| `webhook-receiver` | starter | HMAC-signed JSON event: header parameters and body schema declared, signature checked with `node:crypto` in a trusted function, `202` | secret grant (`--policy`) |
| `typescript` | intermediate | Typed function transpiled by `build-typescript` | build step |
| `static-plus-api` | intermediate | Page, static directory and one JSON endpoint declared with `respond`, no project code | nothing (self-hosted, AWS, Vercel) |
| `streaming-progress` | intermediate | Progress lines sent while a trusted function works, with `stream: true` ([streamed responses](SPECIFICATION.md#streamed-responses)) | self-hosted runtime |
| `cors-api` | intermediate | Preflight and CORS headers from route middleware around a declared `respond` | self-hosted runtime |
| `contact-form` | intermediate | Message checked by `request.body.schema`, `202` from `respond`, fixed signal to a hook after the response, no project code | signal grant (`--policy`) |
| `middleware` | advanced | Fourteen reusable middleware patterns ([described here](MIDDLEWARE-EXAMPLES.md)) | self-hosted runtime |
| `authenticated-json-api` | advanced | Function behind `auth: true` | operator auth extension, `--host-file`, `--origin` |
| `protected-download` | advanced | Native attachment behind `auth: true` | operator auth extension, `--host-file`, `--origin` |
| `store-crud` | advanced | Persistent JSON CRUD for a declared collection, no handler code ([store](STORE.md)) | `store` extension (`urlcode extensions add store`), `--host-file`, `--origin`; or initialize with `urlcode init DIR --with ui,auth,store --example` |

Each recipe contains a README, `tests/requests.json` and editable files.
Replace example destinations and review the resulting files before use. The
authenticated recipes declare `extensions.auth` and protect their route with
the short form described in [extensions](EXTENSIONS.md); their README shows the
minimal host-file fixture that reproduces the bundled tests.

Recipes are declarative first ([project direction](PROJECT-DIRECTION.md)): a
field check is `request.body.schema` or a parameter `pattern`, a fixed answer is
`respond`, and a function appears only for what YAML cannot express. The
`webhook-receiver` function is the example: everything but the signature is
declared, and the HMAC check runs in a trusted function with `node:crypto` and a
granted secret. A `sandbox: true` route has no crypto API, so it cannot verify
a signature; untrusted input alone is not a reason to sandbox
([AI authoring](AI-AUTHORING.md)). `urlcode review` reports a function that
duplicates `request.body.schema` or answers a constant response
([tooling](TOOLING.md#project-review)).

## `recipe.yaml`

Every recipe carries `recipe.yaml`, validated against
[`schemas/recipe.schema.json`](../schemas/recipe.schema.json) by `npm run check`:

- `id`, `description`, `tags`, `complexity` (`starter`, `intermediate`,
  `advanced`): written by hand; `search` matches id, description, tags and
  capabilities, every word must match, and whole-tag or id hits rank first;
  at an equal score a recipe that runs no project code ranks first.
- `capabilities`, `targets`, `routes`: derived from the capability preflight
  (`analyzeProjectCapabilities` per target after site expansion). The check
  refuses a hand-edited value that differs, so a recipe cannot claim a target
  it does not activate on. `targets` is `compatible`, or the strongest issue
  (`conditional`, `unknown`, `refused`); `routes` is the `--expect-routes` value.
- `services` (external services), `grants` (operator grants, never from project
  files), `inputs` (what to edit), `files` (the copy list), `tests` (fixtures
  and the exact commands) and `behavior` (one observable statement per line).

`show` prints this metadata before the file contents so a reader sees what a
recipe needs before its files scroll past; `--json` returns the same object with
a `content` map. `list` prints one line per recipe, or the metadata with `--json`.

## Examples

`examples/*/example.yaml` uses the same schema, and `urlcode examples search
<text> [--json]` returns the smallest matching runnable example first with the
file to read. The cookbook's forty routes are indexed per route in the generated
[`examples/cookbook/route-index.json`](../examples/cookbook/route-index.json)
(handler, methods, capabilities, policies and middleware module names as tags;
`npm run docs:cookbook-index` regenerates it and `npm run check` refuses a stale
copy), so a search for `etag` answers the cookbook and its `/versioned` route.
Entries without a `urlcode.yaml` (operator rules, monitoring configuration,
scripts) are `runnable: false` and carry no derived fields.

`urlcode examples add NAME --out NEW_DIRECTORY [--dry-run]` copies a runnable
example into a new directory with the same guarantees as `recipes add` below. It
copies every file of the packaged example except its catalog metadata
(`example.yaml`, the cookbook's `route-index.json`); files an authoring copy
refuses, such as dotfiles and `package.json`, are listed under `omitted` and stay
readable in the installed package. A non-runnable entry is refused; read its
files with MCP `get_example`, which also returns the `add` command for a
runnable one.

### Listed commands

`tests.commands` of every recipe and example run as written from the directory
`recipes add` or `examples add` creates, with only the published package
installed (a non-runnable example's commands run from the project it applies
to). A `/operator/` path is an operator-owned location outside the project,
written by an earlier command or supplied by the operator; a `<...>` placeholder
is operator input. `npm run check` refuses a command that starts with anything
but `urlcode`, `node`, `npm` or `npx`, or names a path of the source checkout, and the package
smoke test (`npm run test:package`) copies each example with fixtures from the
packed archive and runs its commands verbatim.

## Adding a recipe

`add` creates a new standalone directory. It refuses an existing destination,
even an empty directory; it never merges or overwrites existing project routes.
Review or copy selected declarations manually when combining projects. Dry-run
reads and validates the packaged recipe and checks the destination, but writes
nothing. The output parent must already exist and be owned by the caller.
Dependencies are written first and the complete `urlcode.yaml` is published by
rename last. A failed write removes the new directory. This is atomic project
activation, not an atomic directory replacement or a guarantee against a local
attacker concurrently replacing the caller's output directories.

## SDK and MCP

The SDK provides `listRecipes()`, `searchRecipes(text)`, `showRecipe(name)`,
`addRecipe(name, output, {dryRun})`, `listExamples()`, `searchExamples(text)` and
`addExample(name, output, {dryRun})`.
Catalog names are a fixed list in code; metadata and file lists come from each
schema-checked `recipe.yaml` and are returned as copies. Unknown names and
arbitrary paths/URLs fail closed. The stdio MCP server adds `search_recipes` and
`search_examples` beside `list_recipes` and `get_recipe`
(`recipes_list`/`recipes_show` still work as deprecated aliases; [tooling](TOOLING.md)). Integration tests run every recipe through the real
runtime with its fixtures and audit it with its declared route count (after
building the TypeScript recipe, with a fixture registry for the authenticated
ones, the generated policy for the contact form and the webhook receiver, and
the webhook fixtures' test key in the process environment). `store-crud` runs against the
real `storeExtension` from `packages/store` with a temporary data directory, and a
separate test drives its full lifecycle across a restart.
