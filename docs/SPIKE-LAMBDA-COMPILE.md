# Spike: compiling `function` routes into their own Lambdas

> Review update, 2026-09-19: Current baseline: trusted Node execution is the default, so fresh invocation
> state is a guarantee of `sandbox: true` only. AWS/Vercel still reject functions
> and middleware in `src/capabilities.ts`; changing the default did not implement
> a provider adapter for them. Re-evaluate the proposed per-route lowering against
> a single trusted Node deployment per project before choosing either. Removed
> link APIs in the analysis below are historical.


Status: proposal, nothing implemented. No code in this repository does any of
this, and nothing here is committed scope.

AWS already deploys today. `createLambdaHandler` (`src/aws.ts`) runs a project
as **one** Lambda behind a Function URL or an API Gateway HTTP API, reading the
same `urlcode.yaml` that runs locally — see [AWS](AWS.md). What it cannot serve
is `function`, `middleware` and `link`, which
`activateNativeOnly` (`src/adapters.ts`) refuses for the whole deployment at
activation rather than letting individual routes fail per request.

This spike asks one question: **is the refusal of `function` a fact about
Lambda, or a fact about the adapter?** It argues the second, sketches the
lowering that follows, and is deliberate about what that lowering costs.

## 1. Where the refusal actually comes from

`src/capabilities.ts` gives the reason:

```
capability === 'function' ? 'isolated functions need worker threads and the WASM engine'
```

That is true of the runtime's *own* mechanism. Isolation for guest code is
QuickJS inside WebAssembly, driven from worker threads, with the boundaries
[function security](FUNCTION-SECURITY.md) lists: no `process`, no filesystem,
no sockets, no `fetch`, a fresh guest heap per invocation, and bindings denied
unless an operator granted them by exact name.

A single Lambda cannot host that engine cheaply, because every cold start pays
worker startup and WASM instantiation before the first request. So the adapter
refuses — correctly, for the shape it is.

But nothing in that sentence is about Lambda. It is about *one process serving
every route*. Change the deployment unit and the sentence stops applying.

## 2. The lowering

Cloudflare already establishes the pattern: where a platform forbids what the
adapter needs, URLCode **compiles ahead of time** instead of adapting at
runtime. `urlcode build --target cloudflare` (`src/build-cloudflare.ts`) emits
an artifact the Worker reads, and refuses at build time anything it cannot
serve, with the route named — see [Cloudflare](CLOUDFLARE.md).

The same move for AWS: a build step emits **one Lambda per `function` route**,
plus the existing native-handler Lambda for everything else.

```
urlcode build --target aws --project . --out dist

dist/
  routes/            the native handler Lambda (redirect, respond, page, static, download)
  fn/<route-id>/     one directory per function route
  template.yaml      the generated stack
```

The guest source becomes the Lambda's handler. There is no QuickJS in the
request path, because the request never crosses a guest boundary inside a
process — the process *is* the boundary.

This is not a smaller change than it looks. Three things follow from it.

## 3. What changes, stated plainly

### 3.1 The isolation guarantee is replaced, not preserved

This is the claim most likely to be made too early, so it goes first.

QuickJS-WASM and a Lambda are both real isolation. They are **not the same
isolation**, and neither strictly contains the other:

| | QuickJS-WASM | per-route Lambda |
| --- | --- | --- |
| Network | unavailable unless a binding is granted | available by default; must be removed |
| Filesystem | unavailable | a writable `/tmp`, and the deployment package |
| Environment | not exposed to the guest | ambient unless scrubbed |
| Blast radius of an escape | the guest heap | the function's IAM role |
| Per-invocation state | fresh heap, guaranteed | a warm container may be reused |

The two rows that matter most are the last two. A guest that escapes QuickJS
reaches a heap. A guest that misbehaves in a Lambda reaches **whatever that
Lambda's execution role can reach** — so the compiler would have to emit a role
per route that grants exactly the route's declared bindings and nothing else,
and that emitted role becomes a security-critical generated artifact.
Warm-container reuse is the other: the runtime currently *guarantees* fresh
state per invocation, and Lambda does not.

The honest framing, and the one the docs would have to carry: per-route Lambdas
are **a substitute for the sandbox, not the sandbox**. Anything that says
"functions now work on AWS" without saying which guarantee changed is a claim
this project should not make.

### 3.2 `middleware` is the hard part, not `function`

`function` lowers cleanly because it is a leaf. `middleware` is a per-request
chain, and there are only two ways to lower it, both with a real cost:

- **Inline** the chain into each function Lambda at build time. Cheap at
  runtime; duplicates the middleware into every function's package, and a
  middleware change rebuilds every function.
- **Orchestrate** — a hop per middleware. Composable; adds a Lambda invocation
  of latency and cost to every request, on the hot path.

Neither is obviously right, which is exactly why this spike scopes middleware
out rather than picking one under time pressure.

### 3.3 `link` does not fall out of this at all

Stored live links need a durable writable store that instances share. That is
the same refusal before and after this change. DynamoDB is the natural lowering,
but it is a store implementation with its own export and restore discipline, not
something a compile step produces. (Note: the native `link` handler this
section describes was later removed from core; see
`docs/SPIKE-CORE-LAYERING.md`.)

## 4. Emitting infrastructure is a new kind of output

`examples/aws/template.yaml` is hand-written today. Generating a stack means
this project starts owning a surface it has never owned:

- The generated template is only as correct as the provider's current
  behaviour, which changes without asking.
- A generated IAM role is a security artifact (3.1), so "the template is
  internal, don't rely on it" is a weaker disclaimer here than it was for the
  Cloudflare artifact.
- The gap simply *moves* unless the emitted stack is checked against the
  project. `urlcode verify-deployment --target <url>` already probes a running
  deployment; it would need to cover the multi-Lambda shape, or the build gains
  a new unverified claim while retiring an honest refusal.

That last point is the one worth holding onto. The project's current position on
AWS is **honest**: the capability catalog reports `deployment: 'unverified'` for
every target that is not self-hosted, and [AWS](AWS.md) tells a reader to treat
the limits as unverified until they deploy the example themselves. A compiler
that emits infrastructure nobody has deployed would be a larger unverified claim
wearing the clothes of a capability.

## 5. The capability model already has the right shape

`src/capabilities.ts` (from the target-capability centralization) is where this
lands with no new concept:

```
function / aws:  refused  →  compiled
```

`compiled` already exists as a `CapabilitySupport` value and already means what
is needed here — Cloudflare uses it. `deployment` stays `'unverified'` until
something is actually deployed. The catalog would tell the truth about the new
lowering without anything else in the model changing, and `urlcode capabilities
--target aws` would report it.

## 6. Proposed scope for a first spike

Narrow, so that the isolation story stays clean and the win is real:

**In:** `function` routes, Function URL only, one Lambda per function route,
a generated role per route carrying exactly that route's granted bindings,
and the existing native-handler Lambda unchanged for everything else.

**Out:** `middleware` (3.2), `link` (3.3), API Gateway, VPC, custom domains,
warm-start tuning, and any claim about cost.

**Done looks like:** a project in `examples/` that builds, a generated template
a reader can inspect, `urlcode capabilities --target aws` reporting `function`
as `compiled`, and a written comparison of the two isolation models that a
reviewer can disagree with.

**Not done by that:** a deployment. Everything above can pass without anyone
having run it on AWS, and the spike should say so rather than imply otherwise.

## 7. Prior art worth reading before building this

- **Cloudflare target in this repository** — the closest precedent, and the one
  that establishes compile-not-adapt as a thing URLCode already does.
- **SST, Serverless Framework, AWS CDK** — all generate per-function
  infrastructure from a declaration. The interesting question is not how they
  emit it but how they keep the emitted stack honest as the provider moves.
- **Deno Deploy and Vercel functions** — isolate-per-request models, the closest
  commercial thing to the guarantee QuickJS-WASM gives today.

## 8. Open questions

- Is warm-container reuse acceptable at all, given the runtime currently
  *guarantees* fresh per-invocation state? If not, this lowering is wrong for
  any route that relies on that guarantee, and there is no build-time way to
  tell which ones do.
- Does the generated IAM role belong in URLCode's output, or should the build
  emit a *description* of the permissions each route needs and leave the role to
  the operator — closer to how [function security](FUNCTION-SECURITY.md) already
  keeps grants operator-controlled and outside the checkout?
- Does a per-route Lambda change what `policies` can promise? `throttle` on AWS
  is already `conditional` — "counters are per instance" — and more instances
  make that weaker, not stronger.
- Is one Lambda per route the right granularity, or one per *project* with a
  route parameter, which keeps deployment small but reintroduces a shared
  process?
- What happens to the 6 MB Lambda response limit ([AWS](AWS.md)) for a function
  route that returns a large body — refuse at build time, as the Cloudflare
  target refuses what it cannot serve?
