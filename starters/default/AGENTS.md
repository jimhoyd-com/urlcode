# Working on this project

This project uses URLCode: URL behavior is declared in `urlcode.yaml`, and the
installed runtime supplies routing, validation, middleware wiring, policies,
static serving and authentication. Read this file before changing anything.

## Before writing code

1. Inspect `urlcode.yaml` first, then every file its `includes` list names,
   referenced code and `tests/requests.json`. Preserve unrelated routes.
2. Run `urlcode capabilities` to see what this runtime version implements and
   `urlcode capabilities --target NAME` before promising provider support.
3. Run `urlcode recipes list` and `urlcode recipes show NAME` before writing a
   route; prefer `urlcode recipes add NAME --out DIR` when one fits.
4. Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement. Check supported extensions and recipes first; explain any capability gap.

## Ask the runtime through MCP first

When present, `.mcp.json` registers the read-only `urlcode mcp` server. When it is
available, prefer its tools over reading documents: `get_context`,
`get_capability`, `get_schema`, `search_recipes`, `explain`, `get_manifest`.
With a host file, `get_extensions` also returns schemas, hooks, authoring surfaces
and fast checks; inspect them before replacing extension behavior. CLI fallbacks:
`urlcode context`, `capabilities`, `schema`, `recipes`, `explain`, `manifest`.
`--allow-authoring` is an operator opt-in; never add it yourself.

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

A `function`/`middleware` is trusted, in-process Node with only declared
`args`/`env`/`secrets`. Add `sandbox: true` for code needing isolation, not
merely untrusted input. The sandbox is text/JSON-only; use `proxy`/a binding and
record the reason in `sandboxReason`.

## Checks that count as evidence

```sh
urlcode validate --local
urlcode test
urlcode audit --expect-routes 2
```

Run all three after every change, updating the route count deliberately and
adding `tests/requests.json` fixtures for every new route (positive/negative,
every active method, HEAD). No global install: use `node /path/to/urlcode/src/cli.ts`.

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
