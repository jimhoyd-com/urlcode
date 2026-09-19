# Working on this project

This project uses URLCode: URL behavior is declared in `urlcode.yaml`, and the
installed `@jimhoyd/urlcode` runtime serves it. There is no framework code to
write for routing, validation, middleware wiring, policies, static serving or
authentication; the runtime provides them. Read this file before changing anything.

## Before writing code

1. Inspect `urlcode.yaml` first, then every file its `includes` list names,
   the referenced functions, middleware and `tests/requests.json`. Preserve the
   existing organization and every route you were not asked to change.
2. Run `urlcode capabilities` to see what this runtime version implements and
   which targets support it; `urlcode capabilities --target NAME` before
   promising any provider deployment.
3. Run `urlcode recipes list` and `urlcode recipes show NAME` before writing a
   route from scratch. If a recipe covers the need, add it with
   `urlcode recipes add NAME --out DIR` and adapt the copy.
4. Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement. Check supported extensions and recipes first; explain any capability gap.

## Ask the runtime through MCP first

When present, `.mcp.json` registers the read-only `urlcode mcp` server. When it is
available, prefer its tools over reading documents: `get_context`,
`get_capability`, `get_schema`, `search_recipes`, `explain`, `get_manifest`.
The CLI equivalents are the fallback: `urlcode context`, `urlcode capabilities NAME`,
`urlcode schema PATH`, `urlcode recipes search TEXT`, `urlcode explain PATH`,
`urlcode manifest`. `--allow-authoring` is an operator opt-in; never add it yourself.

## What the runtime provides (this version)

- Handlers, exactly one per route: `redirect`, `respond`, `page`, `static`, `download`, `function`, `proxy`, `conditional`.
- Ordered `middleware` around any handler, declared in YAML, trusted by default.
- Validated inputs: `parameters`, `request.body` and `methods` on the route;
  functions receive validated `args`, never raw user input.
- Policies, host-enforced and off by default: `agents`, `throttle`, `cache`, `security`, `compression`.
- Site conventions under `site`, each generating one native route: `robots` (/robots.txt), `sitemap` (/sitemap.xml), `favicon` (/favicon.ico), `securityTxt` (/.well-known/security.txt), `llms` (/llms.txt).
- Bindings: named `env` and `secrets` references resolved by the operator, never values in YAML.

Never recreate any of these in a function; a missing one is a report, not an
invitation to reimplement it.

## Functions and middleware are trusted by default; sandbox is opt-in

A route's `function`/`middleware` runs trusted, in-process, with full
Node/filesystem/`fetch` access, given only declared `args`/`env`/`secrets`. Add
`sandbox: true` when that code warrants isolation (unreviewed code, a sensitive
secret, complex logic) — not merely for untrusted input, which both modes share.
A `sandbox: true` route gets a text/JSON subset only: use `proxy`/a binding, and
say why in `sandboxReason`.

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

- Report unsupported requirements instead of inventing fields. The schema is
  exact; a field the validator rejects does not exist. Say what is missing.
- Never create or approve operator grants. Request a named binding in YAML and
  stop; the operator grants it outside this project, pinned to the revision.
- Secrets stay out of the project: no keys, tokens or credentials in YAML,
  functions, fixtures, `.env` files that are not ignored, or commit messages.
- Protect a route with `auth: true`/`auth: { role: admin }` where an `auth`
  extension is declared; `cache` likewise expands to `policies.cache`.
- Validation, tests and the audit are the evidence. Local checks are not a
  deployment, a soak test or a security review; do not claim otherwise.

The installed package ships an agent skill with the same loop at
`skills/urlcode/SKILL.md` inside `@jimhoyd/urlcode` (for example
`node_modules/@jimhoyd/urlcode/skills/urlcode/SKILL.md`).
