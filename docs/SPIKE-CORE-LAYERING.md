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
- **A new `urlcode-dynamic-link` and a new `urlcode-middleware`(-shaped)
  repo** both need to exist or be attached before their Phase 2 work can be
  written or verified, matching the constraint already flagged for `link`.

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

## Non-goals

This spike does not decide `link`'s Phase 1 breaking-change policy, does not
design the `middleware` extension's config schema, and does not touch
`function` — `function` stays in core as the serverless-capable primitive
that makes YAML + function a complete product on its own.
