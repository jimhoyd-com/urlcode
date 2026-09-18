# Implemented project contract

This document and [JSON Schema](../schemas/urlcode.schema.json) describe
the source contract, including unreleased additions after 0.3.0.
`version: "1"` remains the project-format contract. Unsupported fields
are rejected rather than interpreted as future behavior.

## Files and validation

`urlcode.yaml` contains `version`, `routes`, and optional `includes` (an explicit
list of project-relative YAML files). Included files have the same version/routes
shape and cannot recursively include files. Duplicate paths across files fail.
See [organization examples](ORGANIZATION.md) for one-file, multi-file and mixed
layouts. All references resolve from the project root, not the including file.
File references resolve inside the project; escaping symlinks fail. No glob,
remote config or arbitrary infrastructure configuration.

YAML 1.2 JSON-compatible values only: string mapping keys, finite numbers,
booleans and null. No duplicate keys, aliases, anchors, tags, merge keys,
multiple documents, reserved prototype keys or nesting of 40+ levels. Unknown
schema fields fail. Files are limited to 32 MiB each, 256 includes and 100,000
routes total, with a 64 MiB aggregate YAML source cap. Loading runs in a worker
with a 256 MiB old-generation heap, a 10-second wall deadline and at most two
concurrent loads per Node isolate. These are not a total process RSS bound.
Route compilation yields every 64 routes and checks a 10-second cooperative
deadline; individual synchronous operations are not preempted. At most 1,000 parameterized routes and 1,024 distinct input schemas.

## Routes

Keys are absolute case-sensitive paths. Trailing slashes are significant.
Parameters occupy whole segments, e.g. `/p/{id}`, with distinct identifier names.
Each parameter matches exactly one nonempty segment, never across `/`; it is not
greedy. No regex paths, client-controlled host dispatch or dot segments. Only static directory mounts
support a terminal `/*` wildcard with an otherwise literal path. Route keys cannot contain
percent encoding, spaces, backslashes or query strings. Path length is limited
to 2,048 characters and 32 segments. `/_urlcode` is reserved.

One handler per route: `function`, `redirect`, `page`, `static`, `download`, `respond`, `link`, `conditional` or `proxy`.
See [asset configuration](ASSETS.md) for file handlers. Optional properties:

- `methods`: unique HTTP methods; default GET and HEAD. Explicit lists are exact;
  adding GET does not implicitly add HEAD. Wrong method returns 405 plus Allow.
- `enabled`: false returns 404, the same as unknown paths.
- `expires`: UTC ISO timestamp (`...ssZ` or `...ss.sssZ`); expired routes return 410.
- `description`: optional authoring metadata.
- `middleware`: ordered list of up to 16 `{source, export?}` modules wrapping any
  handler. See [middleware](MIDDLEWARE.md) for the portable contract.
- `parameters`, `env`, `secrets`: inputs and explicit binding references.

Literal paths win; parameter routes with more literal segments win next;
static mounts follow, longest prefix first. A missing file in the selected mount
returns 404 without falling back to a shorter mount.
Equally specific overlapping patterns fail even if methods differ. Match a route
before checking its methods; do not fall back to a less specific route for 405.
Requests decode the path once; invalid UTF-8/percent encoding, encoded slashes or
backslashes, control characters and dot segments return 400. Query values decode
once. Incoming query data is not automatically forwarded.

See [route matching and new links](ROUTING.md) for examples, precedence, wildcard
limits, reload behavior and the distinction between YAML routes and live link data.

The optional top-level `site` block (entry file only) generates native routes
for site conventions: `robots` → `/robots.txt`, `sitemap` → `/sitemap.xml`,
`favicon` → `/favicon.ico`, `securityTxt` → `/.well-known/security.txt` and
`llms` → `/llms.txt`. Each is an ordinary `respond` or `page` route merged in
before compilation and counted by `routes`/`audit`; a declared route at the same
path wins and the generated one is logged as shadowed. Absolute URLs come from
the operator's `--origin`; `sitemap` refuses activation without one. See
[site conventions](SITE.md).

## Exact conditions and duplicate-path alternatives

Optional route `match` conjunctively compares exact query/header/cookie strings,
an uppercase method and the canonical authority of the operator-configured
public origin. Host/forwarded headers never select the trusted host. A guard
mismatch returns 404 without trying a less-specific path; route method admission
still applies after the guard. Conditions are not authentication or authorization.

The `conditional` handler puts alternatives under one existing route key:
`cases` contains 1–16 `{match, redirect}` or `{match, respond}` entries; optional
`fallback` contains exactly one redirect/respond handler. Duplicate YAML paths
remain invalid. Cases must be provably disjoint: each pair needs a shared
predicate with different required values. Cases run before fallback; no matching
case and no fallback returns 404. Nested cases and branch-local bindings,
middleware or policy are unsupported. Shared inputs, methods, headers,
middleware and policies stay at route level.

Each query/header/cookie map has 1–16 comparisons; names have at most 128
characters and values 1,024. Query comparisons use decoded raw strings without
parameter defaults/coercion. Cookies use unquoted wire values and an 8 KiB input
limit. Missing and empty are different. Duplicate examined scalar inputs return
400 when the transport exposes their counts. Header names normalize to lowercase;
authentication and transport headers cannot be predicates. No regex, geo/device
inference, wildcard or arbitrary-code conditions are supported.

Conditional routing requires cache disabled or no-store and forces downstream
no-store responses. Explicit fixtures are required for branch coverage.
Self-hosted, AWS and Vercel use the shared matcher; Cloudflare refuses conditions
until its artifact compiler supports them. See [conditions](CONDITIONS.md) and
the [executable example](../examples/conditions).

## HTTP request/response configuration

Routes accept `request.body` validation and `response.headers` overrides. The
`respond` handler serves declared text/JSON with a status without running code.
See [HTTP configuration](HTTP.md) for the exact supported fields, precedence,
security restrictions and examples.

## Policies

Optional top-level `policies` and `profiles` keys, and `routes.<path>.policies`,
declare host-enforced behavior around a route: `throttle`, `agents`, `security`,
`compression` and `cache`. All are off unless declared; a route's keys merge
over the project's, `false` disables one, and a target that cannot enforce a
policy refuses activation naming the route. The five policies are implemented
for the self-hosted server; Vercel and AWS accept `agents`, `security`, `cache`
and route-partitioned `throttle`; the Cloudflare build compiles `agents` and
`security` only. See [policies](POLICIES.md) for the pipeline position, merge
rules and the per-target table, and [plugins](PLUGINS.md) for the host hook API
operators pass in code.

## Inputs

Declare each path placeholder as a required string. Query/header inputs may be
string, integer, number or boolean. Query arrays declare scalar `items`; repeated
keys retain order (maximum 100 values). Header names are case-insensitive.
Duplicate scalar query/header inputs return 400. Required missing inputs return
400; defaults apply only to absent inputs. Empty strings are present values.

Supported validation: `type`, scalar `enum`, `default`, string `minLength`/
`maxLength`, numeric `minimum`/`maximum`, query array `items` and `maxItems`.
Regular-expression patterns, structured bodies, cookies, nested inputs and
OpenAPI `style`/`explode` fields are not implemented. This uses a documented
OpenAPI-like input subset; it is not an OpenAPI document or full JSON Schema
input vocabulary. String limits are at most 8,192 characters.

Integers use `-?(0|[1-9][0-9]*)` and must be safe JavaScript integers. Numbers
allow the same grammar plus a fractional suffix; no exponent, plus sign, leading
zeros, whitespace, NaN or infinity. Booleans are exactly `true` or `false`.
Unknown query keys are ignored unless explicitly passed by a redirect.

## Redirects

`redirect.url` is an absolute HTTP(S) URL with literal scheme/host and no embedded
credentials or whitespace/control characters. `{pathInput}` placeholders are
allowed only in the destination pathname and encoded as single components.
No environment/secret interpolation. Status defaults to 302; allowed values are
301, 302, 303, 307 and 308.

`redirect.query.map` maps output keys to `{from: path|query|header, name: input}`
references to declared inputs. Typed/defaulted values are used. Arrays produce
repeated output keys. Absent optional inputs are omitted.
`redirect.query.pass` is false or an explicit allowlist; unrestricted `true` is
not supported. Conflicts between destination keys, maps and passthrough fail.
Declared passthrough inputs use validated/defaulted values; undeclared allowlisted
keys preserve repeated values. Headers are forwarded only through explicit maps.

## Stored links

The entry `urlcode.yaml` must opt in with `dynamicLinks: true` (default false).
Included files cannot set this project-level flag. Parameterized redirects and
functions do not require it.

`link: {collection: links, code: {from: path, name: code}}` resolves a declared
path input against an operator-bound store. GET/HEAD only. The logical collection
is portable; file paths and store credentials are external deployment bindings.
No general storage capability is exposed to guest code. See [dynamic links](DYNAMIC-LINKS.md)
for validation, persistence, mutation, expiry and read-after-write behavior.

## Functions

```yaml
version: "1"
routes:
  /hello/{name}:
    parameters:
      - name: name
        in: path
        required: true
        schema: {type: string, minLength: 1}
    function:
      source: functions/hello.mjs
      export: default
      args:
        name: {from: path, name: name}
    env:
      GREETING: {value: Hello}
```

```js
export default function hello(request, { args, env }) {
  return Response.json({ message: `${env.GREETING}, ${args.name}!` });
}
```

`function` also accepts a string: `function: functions/hello.mjs`. Document
validation normalizes it to the long form above before routing, auditing,
explaining or hashing the project: `source` is the string, `args` maps every
`{param}` segment of the path to `{from: path, name: param}`, and each such
parameter the route does not already declare under `parameters` (by name, with
`in: path`) is appended as `{in: path, required: true, schema: {type: string,
minLength: 1, maxLength: 128}}`. Declared parameters keep their own schema and
order. The string must be a project-relative `.mjs` or `.js` path without `..`
segments; anything else is refused with the route path named. A `middleware`
entry may likewise be a string, normalized to `{source: <string>}`. Only the
long form exists after loading, so `routes`, `audit`, `explain`, revision hashes
and the field reference describe the expansion.

ES modules only (`.mjs` or `.js`, independent of Node package settings).
[Build-time TypeScript authoring](TYPESCRIPT-AUTHORING.md) can produce these
JavaScript modules in a separate output project; serving does not transpile them.
The build never imports application code into Node, uses fixed compiler settings,
and does not perform semantic type checking. Grants must target the built
configuration/source revision. `export` defaults to `default`. Functions execute
inside QuickJS/WASM, never through Node imports. Only relative `.js`/`.mjs`
project imports are supported, with a snapshotted dependency graph. No bare/npm,
Node built-in, remote, dynamic source imports or `import.meta`. Runtime-created
imports remain restricted to the route's middleware and handler dependency graphs; there is no fallback.
Source limits: 128 modules, 1 MiB per module, 4 MiB total.

The current guest API is a **text/JSON subset**, not the complete native Fetch
API: Request `url`, `method`, `headers`, `text()`, `json()`; Headers append/set/
delete/get/has/entries/getSetCookie; Response constructor with string/null body,
`status`, `headers`, `ok`, `text()`, `json()`, static `json()` and `redirect()`.
Requests decode body bytes as UTF-8. Binary/streaming bodies, URL helpers,
fetch/WebSocket, crypto and filesystem are not exposed. Promise/async and
bounded timers (128 pending per invocation) work inside the guest. Unsupported
APIs fail; they never execute on the host. Do not claim full browser/Node API parity.

Context contains `inputs.path/query/header`, `args`, `env`, `secrets`. Arguments
may be scalar literals, input references, `{env: alias}` or `{secret: alias}`.
Bindings use `{value: "literal"}`, `{env: EXTERNAL_NAME}` or `{secret: logical_name}`.
Literal non-secret values need no grant. Every external environment or secret
binding is denied unless an operator policy grants that exact name to the route
and matches the SHA-256 of the current configuration/source snapshot.
A project cannot grant itself capabilities. See [policy setup](FUNCTION-SECURITY.md).
Missing bindings also reject activation. Inspection parses source without running it.

Development may read `.env.local`; process values win. Serving never reads it.
Dotenv supports single-line NAME=value, paired single/double quotes, blank lines
and full-line comments, without expansion/escapes/shell execution. Loading a
value does not authorize exposing it to a function; the policy still applies.

Every invocation has a fresh guest heap and module state. No cross-request
counters, cached secrets or prototype mutation. QuickJS heap limit is 32 MiB,
stack limit 512 KiB; outer worker and deployment limits are additional defenses,
not a claim that total process RSS is capped at 32 MiB. Two workers, no queue;
saturation returns 503. The independent 5-second deadline terminates a worker
and returns 504. Generic failures return 502; worker replacement is bounded.

HEAD invokes the handler as HEAD and suppresses body output. Code must guard
its own application side effects when future brokered integrations are enabled.
Guest console output is discarded. Functions see the configured public origin,
not arbitrary Host/forwarded headers. Request/response bodies default to 1 MiB;
response headers 16 KiB, maximum 256 pairs. Hop-by-hop headers are stripped;
cookies are preserved individually. Default response cache policy is `no-store`.

No unrestricted host execution option exists. Declarative proxy and webhook
signals use the separately granted host broker described in [egress](EGRESS.md);
guests still have no fetch API or general persistent state capability. Approved secrets can be
returned by code that receives them; isolation does not automatically enforce
information-flow rules on authorized inputs. Keep grants narrow and review the
exact pinned revision. The sandbox still needs independent security review before hostile multi-tenant use.

## Reload and status

`dev` polls project YAML/JSON/JS and `.env.local` every 500 ms, plus declared
asset files/directories (including binary assets and explicit build directories).
Asset polling uses file metadata; production assets stay fixed until restart.
The general source scan excludes common
build/dependency directories and hidden files. Includes and source dependencies
must be normal watched files; changes in symlink targets or `node_modules`
require restart. A candidate fully validates and initializes its functions
and snapshots its assets before activation. Invalid candidates leave the old snapshot serving. In-flight
function calls finish on their original snapshot; new requests use the new one.
Production `serve` is a fixed snapshot; restart/redeploy for code, secret or
operator-policy changes. Config/code edits invalidate old binding grants.

The health `version` combines route-definition and asset-representation digests,
not a full artifact digest
or secret fingerprint. Production release identity should be the Git commit and
container image digest. See [operations](OPERATIONS.md).

See [capabilities and normalized route representation](CAPABILITIES.md) for the target catalog,
programmatic compatibility analysis and provider verification limits.

## Authoring, conversion and verification tools

[Interchange](INTERCHANGE.md) imports and exports a strict literal redirect
subset with source diagnostics and dry-run reports. Provider conversions refuse
semantic differences by default; explicit acknowledgment retains warnings and
never reports lossless behavior. [Bulk import](BULK.md) shards CSV/JSON/YAML rows
into ordinary includes while retaining runtime resource limits. [Recipes](RECIPES.md)
are local Git-owned examples; they grant no capabilities. [Build-time TypeScript](TYPESCRIPT-AUTHORING.md)
is separate from runtime execution.

The [tooling SDK and optional local MCP](TOOLING.md) inspect and validate without
executing handlers or reading binding values. [Provider conformance](PROVIDER-VERIFICATION.md)
distinguishes local adapter replay from actual deployment observations; no real
provider deployment is implied by CI. [Proxy and signal egress](EGRESS.md) requires
external revision-pinned operator grants and bounded host-owned transport;
project declarations cannot grant network authority to themselves or guests.

## Bounded outbound behavior

The proxy handler and webhook signals require external revision-pinned origin
grants. [Egress](EGRESS.md) specifies request and response semantics, DNS pinning,
header filtering, size/time/concurrency limits, secret binding, signal guarantees
and shutdown. Project declarations cannot grant network authority to themselves.
All non-self-hosted targets refuse these capabilities.

## Operator-installed extension handlers

The optional `extensions` map declares version-1 extension configuration.
`extension: name` handlers require exclusive literal `/prefix/*` mounts and
explicit operator registration pinned to the project revision. Optional
`policies.extensions` requirements are validated by the named extension and
authorized before cache access. See [extension contracts](EXTENSIONS.md) for
configuration, trust boundaries, lifecycle and target restrictions.
