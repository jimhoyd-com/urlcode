---
name: urlcode
description: Work on a URLCode project, recognized by a urlcode.yaml file with version "1" and served by the @jimhoyd/urlcode runtime. Use this skill whenever a task touches urlcode.yaml, its included route files, functions or middleware under a URLCode project, or asks to add, change, test or deploy URL behavior (redirects, responses, pages, files, functions, policies) in such a project. It teaches the authoring loop and how to retrieve the minimum reference from the installed runtime instead of guessing fields.
---

# URLCode authoring loop

A URLCode project declares URL behavior in YAML; the installed runtime serves
it. Your job is to change the declaration and the minimal guest code it names,
then prove the change with the runtime's own checks. Never reimplement what the
runtime provides, and never invent fields.

## Declarative-first default

> Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement.

Check the installed version's primitives, YAML configuration, policies, supported
extensions and recipes/templates before writing a custom function or middleware.
Keep necessary custom code focused and report the capability gap; never invent
fields or bypass target limits or operator grants. See `docs/PROJECT-DIRECTION.md` in the installed runtime.

## 1. Recognize the project

- The root has `urlcode.yaml` with `version: "1"`. Included route files are
  listed under `includes`; functions, middleware and assets are referenced from
  the project root.
- Read the project's `AGENTS.md` first if present; it lists the handlers,
  policies and commands this runtime version supports.
- Find the runtime: `urlcode` on the PATH, or
  `node node_modules/@jimhoyd/urlcode/dist/cli.js`, or
  `node /path/to/urlcode/src/cli.ts` for a source checkout. Use one form for
  every command below.

## 2. Retrieve the minimum, do not read everything

If the project carries `.mcp.json` (written by `urlcode init`) and your client
has registered the `urlcode` server, prefer its tools over reading documents:
`get_context` (project summary, constraints, exact commands), `get_capability`
and `get_schema` (one capability or YAML fragment), `search_recipes`,
`explain` (a route's effective behavior) and `get_manifest`. The server is
read-only; `--allow-authoring` is an operator opt-in you never add yourself.
Without the server, run the CLI equivalents and read only the output:

```sh
urlcode context --project DIR        # get_context: summary, constraints, commands
urlcode capabilities                 # what this version implements, per target
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
installed package also ships `docs/YAML-REFERENCE.md` (generated field
inventory) and `schemas/urlcode.schema.json`; search them for the one key you
need rather than reading them whole.

## 3. Choose the highest-level supported abstraction

1. If a native handler expresses the behavior (`redirect`, `respond`, `page`,
   `static`, `download`, `proxy`, `conditional`), write YAML only.
2. Check supported extensions and their configuration before custom code. If a
   recipe from `recipes list` is close, `urlcode recipes add NAME --out DIR`
   and adapt the copy into the project's layout.
3. Only then write a function or middleware: one exported handler, relative
   ES-module imports inside the project only, inputs from validated `args`,
   output as a `Response`. `function`/`middleware` routes run trusted and
   unsandboxed by default: full Node, npm, filesystem and `fetch` access, like
   any other project code. Add `sandbox: true` only when that route's own code
   warrants isolation (untrusted input, an unreviewed contribution, a
   particularly sensitive secret) — a `sandbox: true` route then has no
   `fetch`, Node, npm, filesystem, WebSocket, streaming, crypto API or timers;
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

## 4. Prove it

```sh
urlcode validate --local --project DIR
urlcode test --project DIR
urlcode audit --project DIR --expect-routes N
```

Add fixtures to `tests/requests.json` for each new route: positive and negative
cases, every active method, `HEAD`. Update `N` deliberately when routes are
added or removed, and update any `--expect-routes` in the project's README,
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
