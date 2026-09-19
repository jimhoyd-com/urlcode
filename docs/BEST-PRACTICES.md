# Organization and readability

These are conventions for URLCode applications, not extra schema requirements.
Choose the smallest structure that makes a route easy to find, understand and
test. Preserve an existing project's conventions unless there is a clear reason
to change them. See [file composition](ORGANIZATION.md) for enforced rules and
[the YAML guide](YAML-GUIDE.md) for supported features.

## Start small, split by responsibility

The default starter's two routes do not need a framework or many abstraction
layers. A small project can keep all definitions in `urlcode.yaml`:

```text
my-links/
  urlcode.yaml
  functions/
    welcome.mjs
  middleware/
    response-headers.mjs
  public/
    guide.txt
  tests/
    requests.json
  README.md
```

Create only the folders you use. When navigation or ownership becomes difficult,
group by feature, audience or campaign, rather than creating one YAML file per
short link. There is no universal file-size threshold; split when a reviewer can
no longer follow the changes comfortably. Thousands of redirects usually belong
in a few meaningful collections, not thousands of include entries.

For a growing application, colocating feature-specific code is often clearer:

```text
my-links/
  urlcode.yaml
  features/
    welcome/
      routes.yaml
      welcome.mjs
      greeting.mjs
    campaigns/
      routes.yaml
  middleware/
    response-headers.mjs
  public/
    guide.txt
  tests/
    requests.json
  README.md
```

The root remains a short explicit table of contents:

```yaml
version: "1"
includes:
  - features/welcome/routes.yaml
  - features/campaigns/routes.yaml
routes: {}
```

Each included file has its own `version: "1"` and `routes`. Do not add recursive
includes, glob patterns or inherited defaults. Folder names never change public
URLs. Keep the two styles available: folders by file type for small apps, or by
feature when it improves ownership. Neither requires forking the runtime.

## Make a route readable from top to bottom

Use two spaces, no tabs, and one consistent key order. A useful order is:
`description`, lifecycle (`enabled`/`expires`), `methods`, `parameters`,
`request`, bindings (`env`/`secrets`), `middleware`, the handler, then `response`.
This is visual organization, not an execution-order declaration.

Use block style for nested behavior. Short scalar lists such as `[GET, HEAD]`
and small leaf schemas such as `{type: string}` can stay inline. Omit ordinary
defaults unless making them explicit clarifies a decision. Quote timestamps and
numeric-looking header values. Avoid unrelated reformatting when changing a route.

Example `features/welcome/routes.yaml`:

```yaml
version: "1"
routes:
  /welcome/{name}:
    description: A personalized welcome message with a consistent response header
    parameters:
      - name: name
        in: path
        required: true
        schema:
          type: string
          minLength: 1
          maxLength: 80
    middleware:
      - source: middleware/response-headers.mjs
    function:
      source: features/welcome/welcome.mjs
      args:
        name: {from: path, name: name}
    response:
      headers:
        Cache-Control: no-store
```

Example `features/campaigns/routes.yaml`:

```yaml
version: "1"
routes:
  /guide:
    # Keep this temporary so a campaign destination can change later.
    redirect:
      url: https://example.com/guide
```

Use comments for the reason behind a choice, migration notes or a business rule.
Do not narrate obvious syntax or include secrets, private customer details or
stale deployment instructions. `description` is useful authoring metadata; do
not invent `owner`, `tags` or other unsupported YAML fields. Record ownership in
the README or repository tooling instead.

Order routes consistently within each collection, such as alphabetically or by
business flow. Do not rely on file order for precedence: exact routes win before
parameter routes, then static mounts. Avoid ambiguous overlaps; see [routing](ROUTING.md).

## Keep handlers short and name their job

Name files for behavior (`welcome.mjs`, `select-destination.mjs`) rather than
`utils2.mjs` or `handler-final.mjs`. Name exports clearly even when using a default
export. Use descriptive variables and early returns for error cases. Separate
business transformations from Request/Response handling when that improves clarity.
Do not extract a one-line helper merely to create more files.

`features/welcome/welcome.mjs`:

```js
import {formatGreeting} from './greeting.mjs';

export default function welcome(request, {args}) {
  return Response.json({message: formatGreeting(args.name)});
}
```

`features/welcome/greeting.mjs`:

```js
export function formatGreeting(name) {
  return `Hello, ${name}!`;
}
```

YAML `source` paths are project-root relative. JavaScript imports are relative to
the importing module. Explicit `.mjs` filenames make that distinction clear.
Only relative project JavaScript imports are supported; do not introduce npm,
Node, remote imports or a transpilation requirement accidentally. There is a
project-wide module/source budget; excessive fragmentation has a real limit.

Use validated `args` and `inputs` instead of parsing query strings again. Return
JSON through `Response.json`; escape user data explicitly when producing HTML.
For dynamic redirects, map a validated enum to known destinations rather than
accepting any user-controlled URL. Keep modules free of top-level work other than
simple definitions: initialization runs during validation and fresh invocations.

Prefer pure helpers with explicit inputs and outputs. Module globals are not a
cache, database, session store or rate limiter: guest state resets per request
regardless of trust mode. If a route declares `sandbox: true`, review
[sandbox constraints](FUNCTION-SECURITY.md) before choosing dependencies —
trusted (default) routes have ordinary Node module access instead.

## Middleware should have one clear responsibility

`middleware/response-headers.mjs`:

```js
export default async function responseHeaders(request, context, next) {
  const response = await next();
  response.headers.set('x-app', 'my-links');
  return response;
}
```

Use middleware for reusable behavior around a handler, not to conceal the entire
application flow. Prefer YAML headers for fixed route-specific headers; this
example demonstrates a shared wrapper, but native YAML avoids any
function/middleware invocation overhead when no custom code is needed —
including the extra cost of `sandbox: true` where that is declared. Keep
middleware order explicit in each route.

Always return a Response. Call `await next()` once when continuing, or return
an early Response when intentionally stopping. Do not launch unawaited work or
assume background tasks will survive. A body read consumes the request body;
if downstream code needs parsed data, agree on a documented `context.state` field.
Use specific field names to avoid collisions among middleware.

Catch only errors you can handle meaningfully. Do not turn every failure into a
200 response or include secrets in errors. Keep native body/status/header
preservation rules visible in code review. All middleware share the route's
bindings and execution budget; splitting modules does not create privilege
separation. See [middleware semantics](MIDDLEWARE.md).

## Organize tests around observable behavior

Keep runnable HTTP assertions in `tests/requests.json`, currently the single file
read by the CLI. Group adjacent cases by route: ordinary success, HEAD, boundary
inputs, invalid input, wrong method and relevant early responses. Add meaningful
body/header checks instead of relying only on status codes.

For the two-route feature layout above:

```json
[
  {"path":"/welcome/Ada","status":200,"expectBody":"{\"message\":\"Hello, Ada!\"}","expectHeaders":{"x-app":"my-links"}},
  {"path":"/welcome/Ada","method":"HEAD","status":200,"expectBody":"","expectHeaders":{"x-app":"my-links"}},
  {"path":"/welcome/Ada","method":"POST","status":405,"expectHeaders":{"allow":"GET, HEAD"}},
  {"path":"/guide","status":302,"expectHeaders":{"location":"https://example.com/guide"}},
  {"path":"/guide","method":"HEAD","status":302,"expectBody":"","expectHeaders":{"location":"https://example.com/guide"}}
]
```

Additional ordinary JavaScript unit tests for pure helpers are your project's
choice. Unit tests alone do not verify runtime compatibility — including the
guest API restrictions of a route declaring `sandbox: true` — or HTTP framing:
always exercise HTTP behavior through URLCode too. Keep large fixture generation explicit and
deterministic if you add your own tooling; nested test directories and JSON
fragments are not automatically discovered or merged by URLCode.

Assert observable contracts, not incidental timings or internal variable names.
Avoid checking generated request IDs, current Date values or performance numbers
as fixed functional outputs. Test cache/range semantics with controlled assets.
Update expected route counts deliberately when adding or removing a route.

## Keep configuration, code, assets and operations separate

- Git owns behavior and reviewed code. Keep the runtime as a pinned dependency;
  upgrading it should not regenerate or overwrite application files.
- Publish only intentionally public files in `public/`. File filters cannot
  recognize every secret. A harmless filename is not proof of public content.
- Put local secrets in ignored `.env.local`; production values come from the
  operator. Keep operator grants outside the application checkout. Never use
  YAML anchors, shell expansion or generated credentials for convenience.
- Deployment limits, TLS, DNS, DDoS filters and worker tuning belong to operations,
  not invented route fields. Document them separately from portable behavior.
- Live short-code records need durable storage core does not have. The
  `urlcode-dynamic-link` extension provided it and is being retired; its
  published `0.1.0-alpha.1` pins core `0.4.0-alpha.1` exactly and so cannot be
  installed beside `0.4.0-alpha.2`. Treat stored short links as unsupported
  until that work lands somewhere else. General session/application storage
  remains future work.

## Refactor without changing the public contract

Move one feature at a time. Update explicit includes and project-root source/asset
paths, then check relative JavaScript imports. Keep public route paths, methods,
headers and bodies stable unless the change is intentional. Avoid mixing URL
renames, dependency upgrades and folder rearrangement in one review.

Run validate, HTTP tests and the expected-count audit before and after moving
files. Re-review operator grants: code/config changes invalidate the digest even
when intended behavior is unchanged. A successful dev reload is not a production
deployment. Record activation/rollback steps in the project README.

## A useful project README

Document how to install the pinned runtime, start locally, run tests/audit, and
activate a release. Include a small folder map, the owner of each major feature,
public route behavior and required external binding names (never values). State
supported Node/runtime versions and link to matching URLCode docs. Explain any
middleware ordering or surprising defaults that a new maintainer might miss.

For AI-generated changes, require the assistant to follow existing conventions,
keep diffs focused, add response assertions and report checks actually run. Reject
invented YAML keys, hidden side effects and unnecessary abstractions. The
[AI authoring guide](AI-AUTHORING.md) provides a reusable prompt and capability list.
