# URLCode 0.4.3

> **Never published.** 0.4.3 was prepared, but its candidate build failed in the release container (two checks called `git ls-files` on a checkout git treated as dubious ownership), and a source change needs a new version. Nothing was tagged or published for 0.4.3; everything listed here ships in 0.4.5 (0.4.4 was also never published).

Core, UI, auth, admin and store share this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.3 @jimhoyd/urlcode-ui@0.4.3 @jimhoyd/urlcode-auth@0.4.3 @jimhoyd/urlcode-admin@0.4.3 @jimhoyd/urlcode-store@0.4.3
```

## Changes

<!-- github-release-notes:start -->
### admin-scaffold-order.md

The admin scaffold declares that it requires `ui.kit` and `auth.service`, so `init --with` no longer requires naming ui first: any order gives the same site, and a missing dependency is refused before anything is written, naming it.

### auth-store-startup-stage.md

The auth store worker reports the last startup stage it reached, and the readiness-timeout message names it, so a slow start shows where it stalled. The auth scaffold declares what it provides and requires, so `init --with` no longer depends on argument order.

### clean-release-packages.md

Keep published archives to built runtime files and required legal, security and usage material. Auth installations no longer pull the AWS SES SDK unless the operator selects the built-in SES sender.

### core-agent-guidance.md

Agent guidance and diagnostics: the generated `AGENTS.md`, the packaged skills and `docs/AI-AUTHORING.md` lead with one bounded query (MCP `get_context`, else `urlcode context --project DIR`) and then retrieve only what the task needs; `llms.txt` and `docs/AI-AUTHORING.md` carry a task-to-feature index and a handler-choice table, and `urlcode context` points at the same built-ins. The MCP server gains `list_skills`, `get_skill`, `search_docs`, `get_example`, `validate_yaml` and `explain_error`. Unknown-key validation errors name the key, suggest the closest allowed key and truncate long allowed-key lists. `urlcode serve` and `dev` name the host and port when the port is taken. Literal NUL bytes were removed from four source files and a check now rejects new ones. The audit advisory names the exact `sandboxReason` line to add.

### core-declarative-authoring.md

Declarative authoring: `request.body.schema` validates JSON request bodies with a bounded JSON-Schema subset and answers a failing request with 422 (a structured JSON error listing the failing pointer and keyword, never the value, when the client explicitly accepts `application/json`; plain text otherwise). Parameter schemas accept `format: uuid` and a restricted `pattern` (length caps, unsafe patterns refused at activation). A top-level `shared` map holds named `request` and `response.headers` blocks that routes select with `use: <name>`, resolved at load time; YAML anchors stay rejected. `coveredElsewhere` lets a route waive a method that other tests cover, with a required reason. `site.notFound` serves a configured page with status 404 for unmatched GET and HEAD requests (the Cloudflare target refuses it explicitly).

### core-scaffolding.md

Scaffolding: `urlcode init <dir> --with` treats its extensions as an unordered set. Scaffolds declare `provides`, `requires`, `after` and `conflicts`, and core orders them canonically, so any permutation gives the same site and revision pin; a missing requirement, conflict or cycle refuses before anything is written. Risky scaffolds are acknowledged with a repeatable `--ack <extension>:<id>` flag that core hands to scaffolds as an opaque set and rejects when no scaffold consumed it (`ScaffoldRequest.acknowledgements`, `ScaffoldResult.acknowledged`, `routeNotes`). `urlcode init <dir> --template page` writes the smallest page-only project. Extensions that need these contracts must declare a core peer floor that includes them.

### core-testing-and-audit.md

Testing and audit: `tests/requests.json` fixtures can be ordered `steps` with `capture` and `{{name}}` substitution and a `restart` step that restarts the runtime on the same data directory; `startServer` gains `dataDir` and `isolateData`. `urlcode test` is quiet by default (failing cases and a summary; `--verbose` prints every request). `urlcode audit` reports `notReadyReasons`, `waivedRouteMethods`, `ignoredWaivers` and `redundantWaivers`, and its `counts` separate `declared` from `generated` routes. `--expect-routes` still compares the total, including generated site routes such as `/robots.txt`.

### store-collections.md

Collections declare `sortable` and `filterable` fields; list requests take one `sort=<field>` or `sort=-<field>` and up to three equality filters with a stable id tie-break, sorted pages use an opaque cursor that cannot repeat or skip records, and undeclared or malformed names return 400 naming only the key. Unknown query parameters on a list request now return 400 instead of being ignored. The scaffold refuses a writable mount that no access-control extension protects unless `--ack store:public-write` is passed, and writes the access model into the generated README and routes. The unordered `--with` contract is supported.

### store-core-floor.md

The store needs a core release that has `--ack`, the unordered `--with` contract and the extension authoring contract, and its first publication peered on a core that lacks all three. This release's core peer floor is raised to the core release that has them, and release preparation and the publish preflight now refuse a floor below the core API the package uses. The README explains the unknown-option failure an older core produces.

### ui-crud-screen.md

`crudScreen` renders a data-bound list with create, inline edit and delete for a collection declared in `extensions.store`, configured with `screens` (per-field labels and column selection), served with a nonce'd, content-hashed client script and no inline script; an edit in progress survives re-render and a failed update rolls its optimistic change back. `field()` gains `textarea` and `select` controls with `textarea@1` and `select@1` kit partials. `renderDocument` takes an optional `style: {nonce}` and `documentContentSecurityPolicy(nonce)` returns the matching strict CSP, so those pages run under the default `oshp` profile. `init --with ui,store` composes the screen.
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
