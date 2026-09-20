# Historical record

Archived 2026-09-19, when the proposal was **declined**. This records an earlier
proposal, not current instructions. The decision it lost to is
[one Node deployment per project](../../OPEN-DECISIONS.md#accepted-one-node-deployment-per-project);
see also the [current roadmap](../../../ROADMAP.md) and
[current contract](../../SPECIFICATION.md). Remaining acceptance work is not
declared complete by archiving this record.

<!-- trust-model-prose: historical-file -->
<!-- guidance-claims: ignore-file -->

# Spike: compiling `function` routes into their own Lambdas

> Review update, 2026-09-19: Current baseline: trusted Node execution is the default, so fresh invocation
> state is a guarantee of `sandbox: true` only. AWS/Vercel still reject functions
> and middleware in `src/capabilities.ts`; changing the default did not implement
> a provider adapter for them. The per-route lowering was weighed against a
> single trusted Node deployment per project, and **the Node deployment was
> chosen** (2026-09-19). Removed link APIs in the analysis below are historical.


Status: **declined 2026-09-19 — kept as the analysis behind that decision, not
as a plan.** Nothing here is implemented and nothing here is committed scope.
The maintainer chose the alternative this document weighs itself against: a
project that uses `function` or `middleware` deploys as **one trusted Node
process**, and AWS/Vercel keep refusing those routes at activation as a
deliberate position rather than a gap awaiting an adapter. See
[open decisions](../../OPEN-DECISIONS.md#accepted-one-node-deployment-per-project).

Read on for why, and for what a first attempt would look like if real demand for
`function` routes on AWS serverless ever appears and reopens the question.

AWS already deploys today. `createLambdaHandler` (`src/aws.ts`) runs a project
as **one** Lambda behind a Function URL or an API Gateway HTTP API, reading the
same `urlcode.yaml` that runs locally — see [AWS](../../AWS.md). What it cannot serve
is `function`, `middleware` and `link`, which
`activateNativeOnly` (`src/adapters.ts`) refuses for the whole deployment at
activation rather than letting individual routes fail per request.

This spike asks one question: **is the refusal of `function` a fact about
Lambda, or a fact about the adapter?** It argues the second, sketches the
lowering that follows, and is deliberate about what that lowering costs.

Section 0 says all of that again without the jargon; sections 1 onward are the
argument in full.

## 0. In plain terms

This section is the whole spike in ordinary language. Everything after it is the
same argument stated precisely; if the two ever disagree, the precise version
wins.

### What a `function` route is

Most of a URLCode project is description, not code: "this URL redirects there",
"this URL returns that page", "this URL serves that file". You write those in
YAML and never write a program. A **`function` route** is the escape hatch for
the cases YAML cannot describe — you write a small piece of JavaScript, and the
runtime calls it when a request arrives. `middleware` is the same idea, except
it runs on the way *to* other routes rather than answering by itself.

### Where that code runs today

Two ways, and the project picks per route:

- **Trusted (the default).** The code runs directly in the same Node process as
  everything else, at full speed, with the same access the process has. This is
  the default because the person writing the route is usually the same person
  deploying it. See [the decision](../../SPIKE-DEFAULT-TRUST-MODEL.md).
- **Sandboxed (`sandbox: true`, opt in per route).** The code runs inside a
  small, separate JavaScript engine (QuickJS, compiled to WebAssembly) on a
  worker thread. Inside there it has no filesystem, no network, no environment
  variables and a completely fresh memory space on every single call. It can
  only reach the outside world through *bindings* an operator granted by name.
  See [function security](../../FUNCTION-SECURITY.md).

Think of the sandbox as a sealed room inside your own house. Nothing gets in or
out except through a hatch you deliberately opened, and the room is wiped clean
between visitors.

### What happens on AWS today

Nothing, for these routes. If a project contains any `function` or `middleware`
route, the AWS adapter refuses **the entire deployment at startup** and names
what it cannot serve. Everything else — redirects, pages, static files,
downloads — deploys fine as a single Lambda.

That refusal is not a bug or an oversight. It is the runtime declining to
pretend. The alternative would be accepting the deployment and then failing
individual requests in production, which is worse.

### Why it refuses

The sealed room is expensive to build. Every time AWS starts a fresh copy of
your Lambda (a "cold start"), that copy would have to spin up worker threads and
boot a WebAssembly engine *before* it could answer the first request. One
process trying to serve every route in a project, rebuilding all that machinery
on every cold start, is a bad trade.

The key observation of this spike: that reasoning is about **one process serving
every route**. It is not actually about AWS. Change the unit of deployment and
the objection evaporates.

### The idea

Stop shipping one Lambda for the whole project. Instead, at build time, emit
**one Lambda per `function` route** — plus the existing single Lambda for all
the ordinary declarative routes.

Then you do not need the sealed room at all, because each piece of code already
has an entire AWS process to itself. The process *is* the wall. This is the same
move URLCode already makes for Cloudflare: when a platform will not run what the
adapter needs, compile the project ahead of time instead of adapting at runtime.

### The catch — three of them

1. **It is a different kind of safety, not more of the same safety.** A Lambda
   is a genuinely separate box, which is good. But out of the box that box has
   working network access, a writable temp disk, ambient environment variables,
   and an AWS identity (an "IAM role") that can reach real infrastructure. The
   sealed room had none of that. So swapping one for the other is a **trade**,
   not an upgrade — and the documentation would have to say exactly which
   guarantee changed rather than announcing "functions work on AWS now". One
   guarantee is simply lost: the sandbox promises fresh memory on every call,
   and AWS reuses warm containers.
2. **URLCode would start generating security-critical infrastructure.** To keep
   each route's permissions tight, the build would have to write out an IAM role
   per route. A generated permissions file is not an implementation detail you
   can wave away with "don't rely on this" — if it is too generous, it is a
   security hole the project authored.
3. **It would be an unverified claim wearing a capability's clothes.** Right now
   the project's position on AWS is honest: it reports `deployment: 'unverified'`
   and tells you to deploy the example yourself. Shipping a compiler that emits
   cloud infrastructure nobody on the project has ever actually deployed would
   trade an honest refusal for a bigger unproven promise.

### The alternative already sitting on the table — and now chosen

Run the project as **one ordinary Node deployment** — a container or a VM. That
supports `function` and `middleware` today, with no compiler, no generated
infrastructure and no new security surface. It costs you the serverless
operating model: something is always running, and you scale it yourself.

So the real decision is not "can this be built" — it probably can. It is:

> Is there enough demand for running URLCode `function` routes specifically on
> AWS serverless to justify this project owning an infrastructure compiler and a
> second, weaker isolation story?

**That question was answered on 2026-09-19: no.** Nobody has produced the demand
evidence, and the plain Node deployment does the job today, so the Node
deployment is the supported model and the compiler is not being built. The
refusal on AWS and Vercel stays, and is now a position rather than a gap. See
[open decisions](../../OPEN-DECISIONS.md#accepted-one-node-deployment-per-project).
If that demand ever shows up, §6 below already scopes what a first attempt
would be.

## 1. Where the refusal actually comes from

`src/capabilities.ts` gives the reason:

```
capability === 'function' ? 'isolated functions need worker threads and the WASM engine'
```

That is true of the runtime's *own* mechanism. Isolation for guest code is
QuickJS inside WebAssembly, driven from worker threads, with the boundaries
[function security](../../FUNCTION-SECURITY.md) lists: no `process`, no filesystem,
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
serve, with the route named — see [Cloudflare](../../CLOUDFLARE.md).

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

> **Plainly:** both are real walls, but they are different walls, and neither
> one is strictly stronger. Read the table as a trade, not a scorecard.

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

> **Plainly:** a `function` is a dead end — it answers and the request stops
> there, so giving it its own Lambda is easy. Middleware is a queue of steps
> every request walks through on its way somewhere else, and a queue split
> across separate Lambdas has to be either copied into each one or wired up as
> a chain of calls. Both hurt, so this spike does not attempt middleware.

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
something a compile step produces. (The native `link` handler this section
describes was later removed from core.)

## 4. Emitting infrastructure is a new kind of output

> **Plainly:** up to now URLCode has only ever produced things that run *inside*
> a server it was given. Emitting a CloudFormation stack means it starts
> producing the cloud account's own configuration — including permissions — and
> becomes responsible for that being correct as AWS changes underneath it.

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
every target that is not self-hosted, and [AWS](../../AWS.md) tells a reader to treat
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

Narrow, so that the isolation story stays clean and the win is real.
**Plainly: build the smallest version that proves the idea, and resist every
tempting extra.**

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

These are the things a reviewer should press on. In plain terms: *is losing the
fresh-state guarantee acceptable at all; should URLCode write the permissions or
merely describe them; does splitting into many Lambdas quietly weaken the
policies a project already declares; and is one Lambda per route even the right
size of piece?*

- Is warm-container reuse acceptable at all, given the runtime currently
  *guarantees* fresh per-invocation state? If not, this lowering is wrong for
  any route that relies on that guarantee, and there is no build-time way to
  tell which ones do.
- Does the generated IAM role belong in URLCode's output, or should the build
  emit a *description* of the permissions each route needs and leave the role to
  the operator — closer to how [function security](../../FUNCTION-SECURITY.md) already
  keeps grants operator-controlled and outside the checkout?
- Does a per-route Lambda change what `policies` can promise? `throttle` on AWS
  is already `conditional` — "counters are per instance" — and more instances
  make that weaker, not stronger.
- Is one Lambda per route the right granularity, or one per *project* with a
  route parameter, which keeps deployment small but reintroduces a shared
  process?
- What happens to the 6 MB Lambda response limit ([AWS](../../AWS.md)) for a function
  route that returns a large body — refuse at build time, as the Cloudflare
  target refuses what it cannot serve?
