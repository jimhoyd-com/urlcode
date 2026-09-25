---
name: urlcode
description: Work on a URLCode project, recognized by a urlcode.yaml file with version "1" and served by the @jimhoyd/urlcode runtime. Use this skill whenever a task touches urlcode.yaml, its included route files, functions or middleware under a URLCode project, or asks to add, change, test or deploy URL behavior (redirects, responses, pages, files, functions, policies) in such a project. It teaches the authoring loop and how to retrieve the minimum reference from the installed runtime instead of guessing fields.
---

# URLCode authoring loop

A URLCode project declares URL behavior in YAML; the installed runtime serves it. Change the declaration and minimal application code it names, then prove it with the runtime's own checks. Never reimplement what the runtime provides or invent fields.

## Declarative-first default

> Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement.

Check installed primitives, YAML configuration, policies, extensions and recipes/templates before writing custom code. Keep it focused and report the gap; never invent fields or bypass target limits or operator grants. Source checkouts have `docs/PROJECT-DIRECTION.md`; npm installations have it in `llms-full.txt`.
## 1. Recognize the project

- No `urlcode.yaml` yet? `npm install @jimhoyd/urlcode` (scoped; no unscoped `urlcode` package exists), then `npx --no --package @jimhoyd/urlcode urlcode init .` (`--no` runs the installed copy and never fetches; use the same prefix, or the npm scripts init adds, for every later command).
- The root has `urlcode.yaml` with `version: "1"`. Included route files are
  listed under `includes`; functions, middleware and assets are project-relative.
- Read the project's `AGENTS.md` first if present; it lists the handlers,
  policies and commands this runtime version supports.
- Find the runtime: `urlcode` on the PATH, or
  `node node_modules/@jimhoyd/urlcode/dist/cli.js`, or
  `node /path/to/urlcode/packages/core/src/cli.ts` for a source checkout. Use one form for
  every command below.
## 2. Retrieve the minimum, do not read everything

**First step: one bounded query.** MCP `get_context` when the `urlcode` server is registered, otherwise `urlcode context --project DIR` (add `--budget N` to cap it). It returns a compact summary, constraints and exact commands, never a schema dump. Then retrieve only what the task needs: `capabilities NAME`/`get_capability` (its limits), `get_schema`, `recipes search`/`search_recipes`, `explain`, and `get_extensions` when an operator host file exists. The bare `urlcode capabilities` and `recipes list` catalogs, `llms.txt` and `llms-full.txt` are deliberate fallback/reference, not the opening move.

If the project carries `.mcp.json` (written by `urlcode init`) and your client has the `urlcode` server, prefer its tools: `get_context` (project summary, constraints, exact commands), `get_capability` and `get_schema` (one capability or YAML fragment), `search_recipes`, `search_examples`, `explain` (a route's effective behavior) and `get_manifest`. For framework discovery, use `list_skills` before `get_skill`, `search_docs` for a short package-owned excerpt, and `get_example` for one runnable example. Use `validate_yaml` for pasted YAML syntax/schema feedback only; use `validate` for the actual project, then `run_tests` to run its `tests/requests.json` fixtures the way `urlcode test` does. `suggest_fixtures` drafts those fixtures for routes the project's YAML (includes too) alone determines (write the ones it lists under `gaps` yourself), and `summarize_yaml_change` names the routes, code seams and operator grants a change adds. The server is read-only; `--allow-authoring` is an operator opt-in you never add yourself. No `.mcp.json` because this turn runs `urlcode init` itself, in a client that loads it only at session start? Use the CLI commands above this turn (`urlcode mcp print-config > .mcp.json` beforehand, in an empty directory, avoids the gap next time — TOOLING.md#registering-before-init-runs-pre-session-bootstrap-542).
[URLCode AI](https://urlcode.ai/) is an optional, separate hosted service for shared skills and LLM tooling. Its remote MCP supplements this local project server; never replace `.mcp.json` or put its bearer token in project files. Its machine-readable entry point is `https://urlcode.ai/llms.txt`; connection details belong to the MCP client's secret facility and are documented in the URLCode tooling guide.
When the MCP server was started with an operator host file, `get_extensions`
returns installed extension configuration/policy schemas, declared project
hook contracts, supported authoring surfaces and fast checks. Otherwise use `urlcode extensions --project app --host-file host.mjs --json`
from the site when the operator has supplied that host file.
If the site has artifacts installed, call `get_extension_artifacts`, then `get_extension_artifact` for only the schema, example or README needed; without MCP, run `urlcode artifacts list --json` in the site.
These are pinned, inert authoring inputs, not proof of an installed executable extension. Prefer tested first-party extensions when suitable; install those with `urlcode extensions add <name>` (capability only; `--example` also writes demo routes). External/private extensions are allowed: install them separately, wire them into the operator host, and follow EXTENSIONS.md’s "External extensions and AI tooling" workflow for discovery and validation. Catalog install/upgrade commands do not manage arbitrary external packages. Keep changes within the user’s requested scope.
Without the server, run the CLI equivalents and read only the output:

```sh
urlcode context --project DIR        # get_context: summary, constraints, commands
urlcode capabilities                 # complete catalog (fallback, not step one)
urlcode capabilities --target NAME   # before promising a provider deployment
urlcode capabilities NAME            # get_capability: one capability's contract
urlcode schema PATH                  # get_schema: one YAML fragment
urlcode recipes search TEXT          # search_recipes
urlcode explain PATH --project DIR   # explain: a route's effective behavior
urlcode manifest --project DIR       # get_manifest
urlcode recipes list                 # bundled starting points
urlcode recipes show NAME            # one recipe's files, inline
urlcode routes --project DIR         # the routes the project already has
```

When a field or handler is unclear, ask the runtime, not memory:
`urlcode validate --local` names the rejected field and the route. The
installed package also ships `schemas/urlcode.schema.json` and the generated
field inventory in `llms-full.txt`; search only for the key you need.

## 3. Choose the highest-level supported abstraction

1. If a native handler expresses the behavior (`redirect`, `respond`, `page`,
   `static`, `download`, `proxy`, `conditional`), write YAML only.
2. Check supported extensions and their configuration before custom code. For
   an installed extension, prefer declarative config and UI copy/theme/template/
   CSS overrides, then a hook listed in `get_extensions`. Extension hook
   contract v1 runs trusted in-process and rejects `sandbox: true`. If a
   recipe from `recipes list` is close, `urlcode recipes add NAME --out DIR`
   and adapt the copy into the project's layout.
3. Only then write a function or middleware: one exported handler, validated `args`,
   and a `Response`. They run trusted and unsandboxed by default with Node, npm,
   filesystem and `fetch` access. Use `sandbox: true` only when that route's own
   code warrants isolation (unreviewed or third-party code, a secret whose blast
   radius matters, complex logic — not merely request data, which is untrusted in
   both modes) — a sandboxed route then has no
   `fetch`, Node, npm, filesystem, WebSocket, streaming or crypto APIs (bounded timers are supported);
   a need for those in a sandboxed route is a `proxy` route, a binding, or a
   report.
4. Declare routing, validation, middleware chains, policies, static serving,
   caching, throttling and authentication wherever the runtime or a supported
   extension provides them. Use custom code only for the unmet requirement.
   Where a short form exists, it is the highest-level form: `auth: true` or
   `auth: { role: admin }` on a route whose project declares an `auth`
   extension, and `cache: { … }` for `policies.cache`. Each expands to the long
   form; declaring both is refused.

Keep every route you were not asked to change. Match the file organization the
project already uses.

## Build one application

Treat core routes, installed extensions and product UI as one application with
different owners. Core owns routing and policy mechanics; auth/admin own their
security and workflow behavior; the project owns its product pages, brand and
the smallest set of overrides that make it distinct.

For an installed extension, follow its `authoring` surfaces from
`get_extensions` in this order: configuration; theme and copy; component or
template override; project CSS; declared trusted hook. Build a new extension
only for a reusable capability the installed contracts do not provide. A visual
change is not a reason to fork core or copy an auth/admin flow.

For a React frontend with `components.json`, load the official shadcn/ui skill,
run `shadcn info --json`, then use its docs/search or MCP registry before
generating components. The URLCode skill still owns routing, extension and trust;
do not put React components in its shadcn-compatible server template renderer.

Use published `fastChecks` while iterating, then the full project checks before
handoff. Theme/copy should not rebuild framework packages; full workspace checks
may take several minutes, so let them finish instead of repeatedly rebuilding.

## 4. Prove it

```sh
urlcode validate --local --project DIR
urlcode test --project DIR
urlcode audit --project DIR --expect-routes N
```

Add fixtures to `tests/requests.json` for each new route: positive and negative
cases, every active method, `HEAD`. Cases take only `path, status, method, headers,
body, expectHeaders, expectBody` (`schemas/requests.schema.json`); JSON is text. `N` is declared routes plus one per active
`site.*` convention; an audit mismatch reports the declared/generated split. Update it
deliberately when routes are added or removed, and update any `--expect-routes` in the project's README,
Makefile or CI workflow to match. A failing validation names the route; fix
the declaration rather than working around it.

## 5. Grants, secrets and what to report

- A function that needs a secret or environment value declares a named `env`
  or `secrets` binding in YAML and stops there. The operator grants it outside
  the project, pinned to the project revision. Never create, edit or approve a
  grant, policy file or host file, and never put a value in the project.
- Secrets stay out of YAML, functions, fixtures, unignored `.env` files and
  commit messages.
- When the runtime cannot express a requirement (the validator rejects it,
  `capabilities` marks it refused for the target, or it needs guest network
  or persistence), report exactly that with the route and capability named.
  Do not invent fields, degrade silently or claim a workaround is equivalent.
- Report the three commands' results as the evidence. They are not a
  deployment, a soak test or a security review.

## 6. Leave evidence-backed feedback

After a real attempt, draft feedback only for a capability gap, repeated workaround,
documentation/discovery gap or suspected defect. Include the runtime/target, a
sanitized route/YAML fragment, exact validation or test observation, smallest expected
behavior and a proposed fixture. Exclude secrets, customer URLs, raw source and
one-off product logic; search existing issues for likely duplicates. A draft never
authorizes publishing: do not create or comment on a GitHub issue without explicit approval.
