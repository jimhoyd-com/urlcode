# Decision: first-party `function`/`middleware` code is trusted by default

Status: **decided by the maintainer and implemented in `0.4.0-alpha.2`**
(`sandbox`/`sandboxReason` in `schemas/urlcode.schema.json`; see the
`0.4.0-alpha.2` entry in [the roadmap](../ROADMAP.md) and the resulting contract
in [function security](FUNCTION-SECURITY.md)). `0.4.0-alpha.2` is not yet
published to npm. This overturns an
explicit, previously-stated project rule — see "What this reverses" below —
so treat it as a deliberate, recorded policy change, not a code cleanup. The
body below is preserved as written at decision time; where it calls downstream
packages unbuilt, that was true then, and the notes mark what exists now.

## The decision

Project-authored `function` and `middleware` code runs **trusted and
unsandboxed by default** (direct host-process execution, no worker thread, no
QuickJS/WASM, no fresh-heap-per-call cost). Sandboxing becomes **opt-in**,
declared per route by the developer when they judge a specific piece of code
needs it (e.g. code processing input from an untrusted third party, a
plugin/contribution the project owner hasn't personally reviewed, or genuinely
adversarial-input-facing logic).

Rationale on record: the maintainer's own reasoning is that the current
blanket sandbox is a major performance ceiling (2 workers, no queue, shared
across every programmable route — `docs/CAPACITY.md`) that does not scale to
real concurrent traffic "out of the box," and that treating all first-party
code as equally untrusted regardless of the developer's own judgment is the
wrong default for a framework whose primary author is often the same person
deploying it. The alternative (sandboxed-by-default, opt-in-to-trusted) was
raised and explicitly rejected in favor of this direction.

Industry comparison supporting this call: mainstream frameworks that serve
AI-agent-generated backend code today (Express, Next.js API routes, Django,
Rails) run that code directly in the host process at serve time, unsandboxed,
identically to hand-written code — there is no mainstream precedent for
production request-handling code running in an isolated engine. Where the
industry *does* sandbox AI-generated code (E2B, Modal sandboxes, OpenAI Code
Interpreter, Anthropic's own code execution tool) is at generation/dev-time,
while the agent is writing and iterating — not at serve-time once code is
reviewed and deployed. URLCode's current design is the unusual one: it keeps
the isolation boundary at production serve-time rather than following the
"sandbox generation, trust deployment" pattern the rest of the ecosystem
uses. This decision brings first-party `function`/`middleware` code in line
with that mainstream pattern by default, while keeping the stricter,
less-common serve-time isolation available as an explicit opt-in for code
that specifically warrants it.

## What this reverses — read before touching anything else

This is not additive; it contradicts explicit, multiple-file statements that
currently describe the opposite as an unconditional guarantee. All of the
following assert or depend on "guest code is always sandboxed, regardless of
origin, even your own repository," and need to be rewritten, not just
extended, once this ships:

- `AGENTS.md:9-11` — "Treat all application code as untrusted... never add a
  host-code execution fallback."
- `docs/FUNCTION-SECURITY.md:3-6` — "Application code is untrusted even when
  it came from your own Git repository... There is no `unsafe`, `trusted` or
  automatic host-execution fallback." (This line directly anticipated and
  rejected exactly this proposal; it cannot be left standing as written.)
- `SECURITY.md:3-5` — "Application functions are untrusted by default...
  There is no unrestricted host-execution fallback."
- `docs/SANDBOX-REVIEW.md:5-6` — "No unrestricted Node execution fallback is
  permitted."
- `docs/SECURITY-AUDIT.md` and `docs/PROJECT-DIRECTION.md:25-27` — the
  "not a general Node web framework" framing and residual-risk reasoning
  assume any guest code could be adversarial.
- `README.md`'s function description states the sandbox as an unconditional
  runtime property, not a mode a route opts into.
- `docs/AI-AUTHORING.md` treats `FUNCTION-SECURITY.md` as required reading
  with no first-party exemption in the authoring contract.

None of these can be quietly left in place once `trusted` is the default —
an operator or a security reviewer reading them after this ships would be
reading claims the runtime no longer makes.

## What has to actually change (not just docs)

There is no execution branch for this today — sandboxing is hardwired, not a
config path. Per the earlier sweep:

1. **Schema/types**: a per-route (or per-function-declaration) field, e.g.
   `sandbox: true`, defaulting to `false`/absent = trusted. Needs a home in
   `schemas/urlcode.schema.json` and `src/types.ts` (`RouteConfig`, whatever
   shape `function`/`middleware` declarations take).
2. **Execution path**: `src/functions.ts`/`function-worker.ts` currently has
   no branch that skips `FunctionPool`'s worker/QuickJS dispatch and calls a
   guest export directly in-process — that in-process path needs to be built
   from scratch as the new default, with the existing sandboxed path kept
   fully intact and reachable via the opt-in flag.
3. **Trust-declaration integrity**: since this is opt-out rather than
   opt-in, the risk shifts from "can code fake being trusted" (the sandboxed
   default's concern) to "does everyone correctly opt untrusted-input-facing
   code INTO the sandbox." That's a documentation/authoring-guidance problem,
   not an enforcement one — `urlcode audit`/`validate` cannot know a
   developer's intent, so the authoring docs (`docs/AI-AUTHORING.md`, the
   generated project `AGENTS.md`, the `urlcode-authoring` skill) need to
   clearly teach **when** a project should reach for `sandbox: true` — e.g.
   code parsing third-party webhook payloads it doesn't fully trust, a
   contributed function nobody on the team reviewed, anything handling a
   secret binding it can't fully vet. Reasonable defaults in generated
   scaffolding (recipes, starter templates) should still model this judgment
   correctly rather than silently omitting it everywhere.
4. **Test suite**: `test/sandbox.test.ts`, `test/sandbox-pool.test.ts`,
   `test/egress.test.ts`, `test/middleware.test.ts` and related isolation
   suites (~60-90 tests) stay valid for the `sandbox: true` path unchanged;
   new tests are needed for the trusted default path (it can reach Node APIs,
   the module graph, etc., on purpose) plus tests confirming the two paths
   don't cross-contaminate (a trusted-path failure can't be mistaken for a
   sandboxed one, and vice versa).
5. **Capacity docs**: `docs/CAPACITY.md`'s worker/deadline/heap numbers stay
   as the sandboxed-path limits; the trusted path needs its own documented
   capacity model (ordinary Node concurrency, the existing HTTP admission cap
   `--max-in-flight`, no worker-pool ceiling) — see the concurrency
   discussion earlier in this conversation for the concrete numbers.
6. **Extension-model consistency**: `auth`/`admin`/`ui` already run trusted
   via a *different* mechanism (`authorize()`/`handle()`, operator-installed,
   revision-pinned packages outside the project). This decision does not
   merge that model with first-party `function`/`middleware` trust — they
   remain two separate trust paths that happen to both be unsandboxed, for
   different reasons (operator-vetted package vs. developer's own judgment
   call). Keep that distinction explicit in the docs rewrite so "trusted"
   doesn't become one undifferentiated concept.

## Cross-repo impact

Same caveat as `docs/SPIKE-CORE-LAYERING.md`: `urlcode-auth`, `urlcode-admin`,
`urlcode-ui` are not attached to this session, so the following is reasoned
from the documented contract, not verified against their source — confirm
with `add_repo` before treating it as settled.

- **`auth`/`admin`/`ui` themselves: contract unaffected.** They run through
  `authorize()`/`handle()` — a separate mechanism from `function`/`middleware`
  guest execution, unchanged by this decision. No `RuntimeExtension` code
  changes needed on their side.
- **But their own docs/examples likely need an audit anyway.** If any of the
  three repos' READMEs, threat-model docs, or example projects describe core's
  sandbox as an unconditional guarantee (language inherited from today's
  `AGENTS.md`/`FUNCTION-SECURITY.md` wording, which this decision replaces),
  those statements become inaccurate the moment core ships the new default.
  Anywhere one of these repos ships an example `urlcode.yaml` with `function:`/
  `middleware:` routes (onboarding docs, a demo, a conformance fixture), it's
  now running trusted by default unless that example explicitly opts into
  `sandbox: true` — worth checking whether any existing example implicitly
  depends on sandboxing (e.g., a demo built to showcase "safe to run
  arbitrary/third-party code") and would silently stop meaning what it claims.
- **This is a behavior change, not just a schema addition — versioning must
  reflect that.** A project upgrading core with zero YAML changes gets a
  materially different execution model for every existing `function`/
  `middleware` route it already has. That needs a major/minor version bump
  with an explicit changelog entry and migration note (not a patch release),
  and `peers.json` in `auth`/`admin`/`ui` (`docs/SPIKE-CORE-LAYERING.md`'s
  §2.2 reference) should pin deliberately to a core version that includes
  this change, not inherit it silently on a routine bump.
- **`urlcode-dynamic-link` (built and published since; was planned when this was written): unaffected.** It's a
  mount-based extension like `auth`, not a `function`/`middleware` consumer —
  nothing here changes its design.
- **`urlcode-middleware` (built and published since; was planned when this
  was written): same rule applies — decided.** First-party middleware is trusted by default, exactly like
  `function`; `sandbox: true` is the same opt-in a developer reaches for
  when a specific `middleware:` wrap genuinely warrants it (e.g. it's
  processing input from a source the developer doesn't fully trust). This
  was flagged as an open fork (middleware's wider blast radius — it wraps
  every request through a route, not one operation) and the maintainer has
  resolved it: one uniform default across `function` and `middleware`, not a
  special case. `docs/SPIKE-CORE-LAYERING.md`'s middleware section, which
  still describes middleware as sandboxed-by-default, is superseded by this
  and needs updating to match.
- **Extension-authored project-level lifecycle hooks: same rule, no special
  case.** `docs/EXTENSIONS.md`'s "Project-level lifecycle hooks" section
  settles this explicitly: a hook a project names in an extension's own YAML
  config (`urlcode-auth`'s `onSignUp`/`beforeRegister`/`onDelete` and the
  like) is first-party project code in the same category as any
  `function`/`middleware` route, trusted and in-process by default, with the
  same per-hook `sandbox: true` opt-in. No hardwired always-sandboxed case
  for lifecycle hooks specifically.

## Recommended sequencing

This is independent of, but touches the same files as, the `link`/
`middleware` extraction in `docs/SPIKE-CORE-LAYERING.md`. Recommend landing
this trust-model change first, since it changes what "keep middleware
sandboxed" in that spike even means (middleware's default execution mode
changes too) — building the extraction against the old assumption first
would mean redoing it once this ships. `docs/SPIKE-CORE-LAYERING.md`'s
middleware section will need a follow-up pass once this decision's schema
shape exists.

## Not decided here

- The exact field name/shape (`sandbox: true` vs. `trust: sandboxed` vs.
  something else) — a naming/schema-design pass, not a policy question.
- Whether `link`'s extraction or the `static` target need any changes as a
  result — on current understanding, no (neither touches guest-code
  execution), but worth re-checking once the schema shape is settled.
- The actual rewritten wording for `AGENTS.md`/`SECURITY.md`/
  `FUNCTION-SECURITY.md` — drafting that is a deliberate writing pass, not
  something to improvise inline here.
