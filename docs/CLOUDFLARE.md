# Deploying to Cloudflare Workers

Cloudflare Workers is not a Node host. There is no `worker_threads`, no
filesystem, and code generation at runtime is forbidden. So this target does not
adapt the runtime the way [Vercel](VERCEL.md) and [AWS](AWS.md) do — it
**compiles the project ahead of time** and ships a Worker that reads the result.

```sh
urlcode build --target cloudflare --project . --out dist
npx wrangler deploy
```

A working project is in [`examples/cloudflare/`](../examples/cloudflare/).

## Declarative routes only

This target serves **redirects** and **declared responses** (`respond:`), with
path, query and header parameters, defaults, validation, response headers,
`enabled` and `expires`. Everything else is refused **at build time**, with the
route pattern and the reason named:

| Handler | Why it is refused |
| --- | --- |
| `function`, `middleware` | need worker threads and the QuickJS WASM engine |
| `page`, `static`, `download` | need a platform static-asset binding, not an inline copy |
| `env`, `secrets` | would have to be baked into the artifact |

Generated [site conventions](SITE.md) follow the same table: `robots`,
`sitemap` and `securityTxt` are `respond` routes and compile into the artifact
(pass `--origin` to `build` for the absolute URLs they contain); `favicon` and
`llms` are `page` routes and are refused.

A build artifact is a file that gets copied, cached and committed by mistake, so
it never carries a secret. That is why `env` and `secrets` are refused even when
the value is a literal in the YAML.

Refusing at build time rather than at runtime is the point: a project that
cannot be served fails `urlcode build`, so it never reaches a deployment.

## What the build emits

`--out` receives three generated files. None of them are edited by hand, and
`dist/` belongs in `.gitignore`:

- `artifact.js` — the compiled routes. **This is an internal build output, not a
  published contract.** Its `format` may change in any release, and the runtime
  refuses a format it does not recognise rather than guessing. Always rebuild
  with the same version of URLCode that the Worker imports.
- `validators.js` — the parameter schemas, precompiled by Ajv into standalone ES
  modules. The platform forbids runtime code generation, so a validator cannot
  be compiled on the Worker; it has to be compiled by the build.
- `index.js` — the Worker entry, which is three lines over
  `createFetchHandler` from `@jimhoyd/urlcode/cloudflare`. That import resolves to the
  package's built `dist/cloudflare.js` (and its declarations, for a TypeScript
  Worker); the artifact never depends on the TypeScript sources or on type
  stripping.

Ajv's standalone output hardcodes a CommonJS `require` for its runtime helpers
even in ESM mode, which an ES module cannot evaluate. The build inlines each
helper from the installed Ajv — the real function, not a copy that could drift —
and fails if it meets a `require` it does not recognise, rather than emitting a
Worker that cannot start.

`wrangler.toml` needs no `nodejs_compat` flag. The runtime and the generated
validators use Web standards only.

## Portability, and where it stops

The Worker shares its route matching, request policy and response policy with
the self-hosted server: `src/match.ts`, `src/http-policy.ts` and
`src/http-response.ts` are the same modules, with no Node imports. Two checks
keep it that way: an ESLint rule forbids `node:` imports in the modules that
ship to the Worker, and `scripts/check.ts` (part of `npm run verify`) walks the
import closure of `src/cloudflare.ts` and fails on any `node:` specifier that
is not an `import type`. `test/cloudflare.test.ts` builds a project, runs the same project on the
self-hosted server, and asserts both return the same status, body and headers
(everything but the per-request identifier) — including the example in this
repository, replayed through the compiled Worker.

[Policies](POLICIES.md) follow the same rule: `agents` and `security` are
compiled into the artifact with project list files embedded as entries,
`compression` is delegated to the edge, and `throttle` and `cache` are refused
at build time with the route named. The artifact also carries the project-level
`security` policy, so the Worker's own 404 and thrown-error responses get the
same security headers the self-hosted server gives them.

Two differences are real and deliberate:

- **Duplicate request headers.** The platform joins repeated headers into one
  value before the Worker runs, so per-header counts do not exist. The
  self-hosted server rejects a duplicated scalar header parameter with 400. Here
  that check cannot fire: the parameter sees the joined value (`a, b`) and is
  validated against its schema like any other. A constrained schema still
  rejects it; an unconstrained `type: string` accepts it where the self-hosted
  server would not. Constrain header parameters you care about. The duplicate
  `Content-Type` check on a declared request body is unavailable for the same
  reason; a joined value fails the media-type check instead.
- **The request target.** The self-hosted server inspects the request line
  verbatim. The Worker only ever sees a parsed `Request`, so the target is
  reconstructed from `URL`, and a malformed target the self-hosted server would
  refuse may have been normalised or rejected by the platform before this code
  runs. Path traversal, control characters, over-long targets and ambiguous `%`
  sequences that do survive are still refused by the shared `parseTarget`.

**This has never been deployed to Cloudflare.** Everything above is verified
against the runtime's own test suite and a local build, not against the
platform. A first real deployment is the next thing that would change that, and
until it happens, treat compatibility with a specific `compatibility_date` and
with Wrangler's bundler as unproven.
