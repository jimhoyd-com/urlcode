# Spike: layering `link` and `middleware` out of core

Status: proposal, nothing implemented. No code in this repository does any of
this, and nothing here is committed scope. This combines two extraction ideas
into one spike because they share a mechanism and a sequence, not because
either is blocked on the other.

## The shape this is aiming at

Core's job is to stay the smallest thing that is still a complete product on
its own: YAML routing (`redirect`/`respond`/`page`/`static`/`download`) plus
`function`, the one primitive with an actual serverless story
([`SPIKE-LAMBDA-COMPILE.md`](SPIKE-LAMBDA-COMPILE.md) — compile each `function`
route to its own Lambda, the pattern `src/build-cloudflare.ts` already uses).
That base alone serves static and dynamic content and deploys anywhere
(`docs/FRAMEWORK.md` layer 1–3). Everything past that — accounts, admin,
stored links, UI kit — is an extension a project opts into. `docs/FRAMEWORK.md`
already describes this as four composed packages; `auth` is the existing proof
that "basic project to enterprise in minutes" works by adding declarations,
not by forking core.

`link` and `middleware` are the two pieces of today's core that don't fit that
story: `link` owns durable state no other core feature needs, and
`middleware` is guest code that only some projects want. Extracting both
narrows core to exactly YAML + function, matching the vision above.

## Why one spike, not two independent ones

Both extractions land on the same extension mechanism, already implemented in
`src/extensions.ts`, and reusing one proof point for both keeps the design
honest instead of inventing two different shapes:

- **Mount ownership** (`route.extension`, `RuntimeExtension.activate` →
  `ExtensionInstance.handle`): an extension owns an exclusive `/prefix/*` and
  answers every request under it. This is the shape `link` needs — it already
  behaves like a self-contained mount (`docs/DYNAMIC-LINKS.md`), and
  `auth`/`admin` already use it for `/account/*` and `/admin/*`
  (`docs/FRAMEWORK.md:10-15`).
- **Wrap without owning** (`ExtensionInstance.authorize`, called when a route
  declares `policies.extensions.<name>` without an `extension:` mount): the
  extension is asked to authorize a request that some *other* handler will
  still serve, and can short-circuit with a `HandlerResult` or return nothing
  (`src/extensions.ts:19`, `docs/EXTENSIONS.md:74-78`: "Its instance handles
  bounded requests and, when used in policies, authorizes requests"). This is
  already exactly how `auth` guards a `redirect`/`page`/`function` route today
  without taking it over.

That second mechanism is the answer to "how does middleware move out without
inventing new extension capability": it doesn't need one. `authorize()` is a
coarser hook than today's ordered guest-code `middleware:` array (extension
code is trusted operator code, not sandboxed per-request JS, and it's one hook
per extension per route rather than an ordered list), but it is structurally
the same "observe/short-circuit a route you don't own" shape `middleware`
needs, proven in production by `auth`. So this spike is really: extraction 1
(`link`) uses the mechanism as built; extraction 2 (`middleware`) is a
narrower question of whether `authorize()`'s shape is *sufficient* for
today's middleware use cases, or needs to grow (ordering, multiple hooks per
route, request mutation) — not whether the mechanism exists at all.

## Sequence: `link` first, `middleware` second — and why it isn't arbitrary

1. **`link` → `@jimhoyd/urlcode-dynamic-link`.** Already scoped in detail in
   a sibling session's reviewed plan (Phase 1: remove `link`/`dynamicLinks`
   from `src/types.ts`, `src/router.ts`, `src/runtime.ts`
   (`src/runtime.ts:269-282`), schema and ~13 test files; Phase 2: the new
   package, blocked on that repo existing/being attached). It is ready to
   execute pending approval and needs nothing from the middleware work to
   proceed.
2. **`middleware` → extension.** Depends on Phase 1's incidental fix, not on
   Phase 2: today `src/capabilities.ts` gives a blanket native/refused
   answer for `extension`/`policies.extensions` without consulting the
   specific registered extension's own `targets`
   (`RuntimeExtension.targets`, `src/extensions.ts:31`) — wrong for any
   self-hosted-only extension. `link`'s Phase 1c makes capability analysis
   extension-target-aware. A `middleware` extension needs that same fix to
   correctly report itself refused on Cloudflare/Vercel/AWS the way today's
   native `middleware` handler is refused there — so it should land after,
   reusing that work rather than duplicating it.

Sequence matters for that one dependency; nothing else forces an order.
`middleware` extraction is otherwise the harder design problem (open question
above: is `authorize()` enough, or does the contract need to grow) and should
not block `link`, which is ready now.

## Cross-repo dependency

Neither extraction is core-only in effect, even though Phase 1 of each is
core-only in *scope*. `docs/FRAMEWORK.md:10-15` lists three other repos —
`urlcode-auth`, `urlcode-admin`, `urlcode-ui` — that already implement
`RuntimeExtension`/`ExtensionInstance` against core's contract
(`src/extensions.ts`). None of them are attached to this session, so the
following is reasoned from the documented contract, not verified against
their actual source; it needs confirming against those repos (via `add_repo`)
before anything here is treated as settled.

- **Core is upstream of every extension repo, never the reverse.** `auth`,
  `admin`, `ui`, and the future `dynamic-link` and `middleware` extensions
  each pin to a core contract version; core does not import or depend on any
  of them (`AGENTS.md`: "Core never imports them"). So the dependency
  direction for both extractions is: land the core contract change and cut a
  release, *then* update/ship the consuming extension repos against it — not
  the other way around.
- **The capability-analysis fix (`link`'s Phase 1c) is additive, not a
  `RuntimeExtension` contract change.** It changes what core *reports* about
  an extension's declared `targets`, not the shape an extension implements.
  On paper this needs no changes in `auth`/`admin`/`ui` — but that assumption
  should be checked against their actual `targets` declarations once those
  repos are available, since a repo currently relying on the old blanket
  native/refused answer could see a new, more accurate `refused` result it
  wasn't expecting.
- **If `middleware`'s extraction requires `authorize()` to grow** (ordering,
  multiple hooks per route, request mutation — the open question above),
  that *is* a breaking `ExtensionInstance`/`RuntimeExtension` contract
  change. `auth` is the one existing repo that implements `authorize()`
  today, so it is the one repo guaranteed to need a coordinated update
  alongside that contract change; `admin` and `ui` need checking for whether
  they implement `authorize()` at all. This is the one place refactor work
  outside this repo is a real, not hypothetical, cost of extraction 2 — and
  a reason to settle the "is `authorize()` enough" question with an
  inventory *before* committing to grow the contract, rather than discover
  the breakage mid-migration.
- **A new `urlcode-dynamic-link` and a new `urlcode-middleware` repo** both
  need to exist or be attached before their Phase 2 work can be written or
  verified, matching the constraint already flagged for `link`.

## Repo governance for the two new repos (decided)

Both `urlcode-dynamic-link` and `urlcode-middleware` follow `GOVERNANCE.md`
and `AGENTS.md` as written, with one explicit decision recorded here per
AGENTS.md's "do not publish packages without an explicit decision":

- **License: Apache-2.0**, same as core, no separate CLA/DCO — matching
  `GOVERNANCE.md`'s "Licensing and participation" section exactly. No new
  licensing terms for either repo.
- **Repo settings mirror core's ruleset** (`GOVERNANCE.md` "Changes and
  responsibility"): `main` protected against force-push/deletion, requires an
  up-to-date branch, passing CI and a PR, squash merges, no ruleset bypass for
  admins or automation, CODEOWNERS recording ownership. CI/release workflow
  shape copied from core's `release.yml` (candidate build → audit → pack →
  attest → publish via trusted publisher, no long-lived npm token), per the
  pattern `docs/NEXT-STEPS.md` §2.1 already used for `auth`/`admin`/`ui`.
  CodeQL required on main, secret scanning and push protection on, same as
  core.
- **Published public from the start** — both the GitHub repo and the npm
  package (`@jimhoyd/urlcode-dynamic-link`, `@jimhoyd/urlcode-middleware`) are
  public, not the "`private: true` until reviewed" alpha pattern
  `auth`/`admin`/`ui` used at their first release. This is a deliberate
  departure from that precedent, not an oversight — record the same alpha
  caveat in each README/status file (source complete, independent review and
  deployment evidence pending) so "public" doesn't read as "reviewed."
- Naming matches convention: repo `urlcode-<name>` ↔ package
  `@jimhoyd/urlcode-<name>`, consistent with `urlcode-auth`/`-admin`/`-ui`.
- Still outside this session's scope to execute: creating the two GitHub
  repos, setting their branch protection/CODEOWNERS, and the actual npm
  publish are maintainer actions, not something done from within this repo's
  checkout.

## Performance considerations

Both extractions keep everything in the same Node process — extensions are
loaded and activated in-process via a host file (`src/extensions.ts`), not a
network hop or separate deployment unit — so neither is a "distributed
system tax." The real costs are narrower and different for each:

- **`link`** moving from a native `runtime.ts` branch (`src/runtime.ts:269-282`)
  to an extension mount means every stored-link lookup now also passes through
  `extensionResponse()` (`src/extensions.ts:164-172`): a header-count/byte-size
  check (≤256 headers, ≤16 KiB), a 1 MiB body-size assert, and a `Cache-Control`
  rewrite. That's small, bounded, per-request work — but `link` is the
  project's most latency-sensitive path (a redirect lookup), and
  `docs/CAPACITY.md:200` already warns "do not extrapolate in-memory redirect
  benchmark numbers to database lookups" for the *native* handler today. The
  extension path adds a fixed increment on top of that existing SQLite-bound
  latency; worth a benchmark comparison (native vs. extension-mounted `link`)
  before calling this cost-neutral rather than assuming it from the code shape.
- **`middleware`** is the sharper question, and it's a trust/isolation change,
  not just a packaging one. Today's `middleware:` guest code runs sandboxed —
  a QuickJS/WASM engine in a worker-thread pool, fresh heap per call, no
  network/filesystem, 2 workers, no queue, 5-second deadline
  (`docs/OPERATIONS.md:128-133`, `src/functions.ts:35-90`). `authorize()`, by
  contrast, is trusted operator extension code running directly in the host
  process (the same model `auth` uses today) — no worker-thread dispatch, no
  per-call WASM heap allocation, so a naive move would likely be *faster*, not
  slower. But that speed comes from **dropping the sandbox boundary**: logic
  that runs as `middleware:` today because a project didn't fully trust it (or
  wanted the isolation guarantee) would run unsandboxed if lowered straight to
  `authorize()`. This needs to be resolved as a design decision, not
  discovered as a side effect: does `urlcode-middleware` keep guest code
  sandboxed (meaning the extension itself has to drive `FunctionPool` or an
  equivalent, keeping the worker-thread cost) or does it accept trusted-code
  semantics like `auth`? The open question in the previous section ("is
  `authorize()` enough") and this one are the same question looked at from
  two sides — get an answer to one and the other follows.

## Other core pieces considered and set aside

Checked against the same test used for `link`/`middleware` — does it own
state or behavior nothing else in core needs, and is it optional rather than
part of the smallest complete product:

- **`proxy`** — explicitly *not* a candidate. The sibling session's plan for
  `link` calls this out directly: unlike `link`, `proxy` is a shared egress
  primitive future extensions are expected to build on, so extracting it
  would create a dependency extensions have on an extension, which core's
  "extensions never depend on each other" shape doesn't support today.
- **`policies`** (`throttle`, `agents`, security headers, compression,
  cache) — these are declarative YAML behavior applied by core to every
  route, not guest code or durable external state; `throttle`/`agents`
  counters are already scoped as "per instance, not distributed"
  (`docs/OPERATIONS.md`), which is a limitation to document, not a reason to
  extract. A bare project (no extensions at all) still needs security
  headers and basic rate limiting, so these stay part of the smallest
  complete product.
- **`conditional`, `static`, `download`, `page`, `respond`, `redirect`** —
  these *are* the YAML-routing half of "YAML + function"; extracting any of
  them would shrink core below the "complete product on its own" bar rather
  than trim it.
- **Management API / operator grants / credential policy** — foundation that
  extensions themselves depend on (`docs/MANAGEMENT-SECURITY.md`,
  `docs/FUNCTION-SECURITY.md`); moving it out would mean extracting the thing
  the extraction pattern relies on.

Nothing else in core matches the `link`/`middleware` shape today. If a third
candidate is going to be found, `docs/REPETITION-LOG.md`'s discipline (`docs/NEXT-STEPS.md`
Phase 6 — extract from observed repetition, not speculation) is the more
defensible way to find it than continuing to eyeball the handler list.

Recommendation: before either Phase 2 begins, attach `urlcode-auth`,
`urlcode-admin` and `urlcode-ui` to a session and confirm (a) their actual
`targets` declarations against the Phase 1c capability-analysis change, and
(b) whether any of them implement `authorize()` beyond `auth`. That turns the
bullets above from reasoned-from-docs into verified, and gives real basis for
sequencing core's release against theirs (e.g. a core minor version that adds
extension-target-aware capability reporting without breaking the contract,
versus a core change that requires those repos to update in lockstep).

## Open questions before either is built

- `link`: hard break vs. deprecation window (pre-1.0, `0.4.0-alpha.1`;
  sibling session's plan recommends a hard break, flagged explicitly since it
  breaks any project with `dynamicLinks: true` until the new package ships).
- `middleware`: does `authorize()` as it exists today cover real middleware
  use cases (auth checks, header injection, simple rewrites), or is an
  ordered/multi-hook extension to the contract required before this is
  viable? This needs concrete inventory of what today's `middleware:` guest
  code is actually used for before designing the replacement shape.
- Both: this repo stays core-only per `AGENTS.md` ("the auth, admin and ui
  extensions live in their own repositories... Core never imports them");
  neither extraction's Phase 2 can be written here.

## The full ladder: one contract, one vocabulary per level

`link` and `middleware` shrink core by moving pieces *out*; there's a
complementary, additive move that extends the ladder *below* core instead of
touching it: a `static` compile target, alongside the existing
`node`/`aws`/`vercel`/`cloudflare` targets in `src/capabilities.ts`. Same
`urlcode.yaml`, same routing vocabulary — the difference between levels is
only which capabilities a given target can serve, exactly the mechanism that
already exists (Cloudflare already refuses `function`/`link`/`middleware`
today; `static` would additionally refuse `function`, keeping only
`redirect`/`respond`/`page`/`static`/`download`). No new syntax, no second
schema, no fork of the contract — a project written once reads as:

```
static hosting (S3, CloudFront)  →  routing + static assets only, no server
node/aws/vercel (serverless)     →  + function, the dynamic primitive
extensions (auth/admin/link/…)   →  + accounts, admin, stored links, middleware
```

This is the same YAML at every level; the only thing that changes is which
handlers a target accepts, reported the same way `urlcode capabilities
--target <name>` already reports it. That's the point being made here: the
progression isn't three different products, it's one contract with graduated
vocabulary, so a project can start at "static site" and grow into "function"
and then "extensions" without a rewrite — just fewer refusals as the target
gets more capable.

This is additive, not part of the `link`/`middleware` extraction: it doesn't
touch core's code, doesn't shrink core's self-definition ("YAML + function"
stays true for the `node`/`aws`/`vercel` targets), and needs nothing from
either extraction to be built. It reuses `build-cloudflare.ts`'s pattern
(compile YAML to the target's native format) for S3/CloudFront redirect
rules and object routing.

**One real gap, not glossed over:** GitHub Pages has no server-side rewrite
layer, so `redirect` routes can't compile to true HTTP redirects there — only
a meta-refresh/JS fallback or a static 404-page trick, both lower fidelity
than what the same route does on every other target. If `static` ships,
GitHub Pages needs either an explicit fidelity caveat in its target
description or exclusion from the `static` target's claimed support, not a
silent "same behavior everywhere" promise the platform can't keep.

## Non-goals

This spike does not decide `link`'s Phase 1 breaking-change policy, does not
design the `middleware` extension's config schema, and does not touch
`function` — `function` stays in core as the serverless-capable primitive
that makes YAML + function a complete product on its own.
