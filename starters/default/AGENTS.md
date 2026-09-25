# Working on this project

This site uses URLCode: URL behavior is declared in `app/urlcode.yaml` (the route project), `host.mjs`
is the operator host composing installed extensions, and the runtime pinned in `package.json` supplies routing,
validation, middleware wiring, policies, static serving and authentication. Read this file before changing anything.

## Before writing code

1. Inspect `app/urlcode.yaml` first, then every file its `includes` list names,
   referenced code and `app/tests/requests.json` when present. Preserve unrelated routes.
2. Make one bounded query first: MCP `get_context` when the `urlcode` server is
   registered, else `urlcode context --project DIR` (DIR is `app`; add `--budget N`
   to cap it). It returns a compact summary, constraints and exact commands.
3. Then retrieve only what the task needs: `capabilities NAME`/`get_capability`
   (limits; `--target NAME` before promising a provider), `get_schema`,
   `recipes search TEXT`/`search_recipes` then `recipes add NAME --out DIR`,
   `explain` and, with an operator host file, `get_extensions`. Bare
   `capabilities` and `recipes list` are complete catalogs: fallback, not step one. Do not read or grep `llms-full.txt` or the packaged docs for a routine task.
4. Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement. Check supported extensions and recipes first; explain any capability gap.

## MCP

When present, `.mcp.json` registers the read-only `urlcode mcp` server; prefer its
tools (also `get_manifest`) to reading documents. Inspect `get_extensions` before
replacing extension behavior. `--allow-authoring` is an operator opt-in; never add it. Prefer tested first-party extensions when suitable. External/private extensions are allowed: install them separately and wire them into the operator host, following EXTENSIONS.md’s "External extensions and AI tooling" workflow in llms-full.txt. Inspect their host registrations and validate/test with that host; catalog commands do not manage arbitrary external packages. First-party extensions are installed with `urlcode extensions available|add|remove` and moved with `urlcode upgrade`, which pins them in `package.json` and wires `host.mjs`. Artifacts are inert add-ons (schemas, example configuration) installed with `urlcode artifacts add`; read them with `get_extension_artifacts`/`get_extension_artifact`, which never activate an extension. [URLCode AI](https://urlcode.ai/) is a separate optional hosted service for version-pinned reference and shared skills; its anonymous remote MCP runs no model of its own and never replaces this local project server. Its machine-readable entry point is `https://urlcode.ai/llms.txt`.

## What the runtime provides (this version)

- Handlers, exactly one per route: `redirect`, `respond`, `page`, `static`, `download`, `function`, `proxy`, `conditional`.
- Ordered `middleware` around any handler, declared in YAML, trusted by default.
- Validated route `parameters`, `request.body`, `methods` and function `args`.
- Policies, host-enforced and off by default: `agents`, `throttle`, `cache`, `security`, `compression`.
- Site conventions under `site`, each generating one native route: `robots` (/robots.txt), `sitemap` (/sitemap.xml), `favicon` (/favicon.ico), `securityTxt` (/.well-known/security.txt), `llms` (/llms.txt), `notFound` (/404.html).
- Bindings: named `env` and `secrets` references resolved by the operator, never values in YAML.

Never recreate these in a function; report a missing capability.

## Build one application

Treat routes, extensions and UI as one application with different owners. Use
published surfaces in order: configuration/theme/copy, smallest template, CSS,
then a declared hook. Keep auth/admin security and workflows package-owned; add
an extension only for a reusable missing capability. Use the official shadcn/ui
skill only in a React frontend with `components.json`; start with `shadcn info
--json`. Do not put React components in the server renderer.

## Functions and middleware are trusted by default; sandbox is opt-in

A `function`/`middleware` is trusted, in-process Node: its injected context holds only declared `args`/`env`/`secrets`,
but the code keeps Node's ambient authority (`process.env`, filesystem, network, installed modules); that is not confinement.
Add `sandbox: true` for code needing isolation, not merely untrusted input. The sandbox is text/JSON-only; use `proxy`/a binding and
record the reason in `sandboxReason`. Try `redirect` (relative or `/**`) or `respond` first; a function gets `context.route.pattern`.

## Checks that count as evidence

```sh
npm run validate   # urlcode validate --local --project app --host-file host.mjs
npm test           # urlcode test --project app --host-file host.mjs
npm run audit      # urlcode audit --expect-routes 0 --project app --host-file host.mjs
```

With no active routes, this initial audit intentionally exits nonzero with `no-active-routes`. Add the first route and its fixture, then make the audit pass; remove `allow-empty-project: true` from the generated GitHub workflow at that point. `N` counts declared routes plus one route for each active `site.*` convention; an audit mismatch reports the declared/generated split. Update it deliberately and add `app/tests/requests.json` fixtures for every new route (positive/negative, every active method, HEAD). A case is `{path, status, method?, headers?, body?, expectHeaders?, expectBody?}` and nothing else (the runtime's `schemas/requests.schema.json`): send JSON as a text `body` with a `content-type` header and assert its exact text in `expectBody`. Without a global install, run any other command as `npx --no --package @jimhoyd/urlcode urlcode … --project app --host-file host.mjs`. Hand a person `urlcode report BEFORE … > report.html` (BEFORE: the earlier checkout) to review a change; it does not replace these checks.

## Feedback

After a real attempt, draft evidence-backed feedback: category, sanitized YAML, observed validation/test result, expected behavior and fixture. Ignore one-off product logic; search existing URLCode issues first; never publish or comment without the user's explicit approval.

## Rules

- Report unsupported requirements; a field the exact schema rejects does not exist.
- Never create operator grants. Request a named binding; the operator grants it
  outside the project, pinned to the revision.
- Keep keys, tokens and credentials out of project files and commit messages.
- Protect a route with `auth: true`/`auth: { role: admin }` where an `auth`
  extension is declared; `cache` likewise expands to `policies.cache`.
- Local checks are not deployment, soak or independent security evidence.

The installed package ships the same loop at `skills/urlcode/SKILL.md` inside
`@jimhoyd/urlcode` (for example `node_modules/@jimhoyd/urlcode/skills/urlcode/SKILL.md`).
