# Open decisions

Status: written 2026-09-19 from a review of the nine repositories. Every item
here is a maintainer decision that documentation cannot make. Each states what
is actually true today, what the options are, what it costs to leave open, and
a recommendation. Nothing here is committed scope; the
[roadmap](../ROADMAP.md) owns sequence and the
[readiness register](RELEASE-READINESS.md) owns what is proven.

This page exists because several documented positions have drifted apart from
each other and from the source. The drift is not the decisions themselves — it
is that they were never recorded in one place where the next contributor, human
or agent, would look.

## 1. Publish `0.4.0-alpha.2` — decided

**Decided 2026-09-19: publish `alpha.2`.** The recommendation below was taken
rather than walking back a correct declaration. The alignment is prepared
across all nine repositories and the order is recorded in
[the version register](VERSIONS.md); what remains is merging and tagging.

The second hazard was taken with it: `@jimhoyd/urlcode-auth` moves `latest`
up to `0.1.0-alpha.2` so that a plain `npm install` no longer resolves a build
older than the floor `@jimhoyd/urlcode-admin` declares. That is a registry
operation (`npm dist-tag add`), not a source change, and it is listed in the
release steps.

The original entry, for the record:

> **Today:** the repository source is `0.4.0-alpha.2`. The npm dist-tags are
> `latest = 0.3.0` and `alpha = 0.4.0-alpha.1`. `alpha.2` carries the
> trusted-by-default execution change ([the decision](SPIKE-DEFAULT-TRUST-MODEL.md)).
>
> **Why it blocks other things:** `@jimhoyd/urlcode-middleware@0.1.0-alpha.1` is
> published with `peerDependencies: { "@jimhoyd/urlcode": ">=0.4.0-alpha.2" }`.
> No published core version satisfies that range, so a registry install of that
> package cannot resolve its peer. The range is correct; the publication order
> was not.
>
> **Recommendation:** publish `alpha.2`. It is the only option that does not
> require walking back a correct declaration.

## 2. Consolidate the repositories, or commit to the split

**Today:** nine repositories. [The monorepo spike](SPIKE-MONOREPO.md) is
complete, its layout is marked decided (option A), its migration mechanics and
sequencing are written, and it has three open questions for the maintainer. It
has been neither accepted nor rejected. It was drafted for four repositories;
`urlcode-dynamic-link`, `urlcode-middleware` and `urlcode-short` have appeared
since.

**Cost of leaving it open:** the migration gets larger with every repository
added, and the coordination work the spike describes — pinning reviewed peer
revisions by hand, chasing prose across repositories when a contract changes —
is paid again on every contract change in the meantime.

**Recommendation:** decide before the next structural change, in either
direction. A recorded "no, and here is what we do instead about cross-repo
drift" closes this as well as a yes does.

## 3. One way to attach middleware, or two

**Today:** core has the native `routes.<path>.middleware[]` array.
`urlcode-middleware` provides the same capability through the extension seam
and states that core's native array "keeps working unchanged".
[The layering spike](SPIKE-CORE-LAYERING.md) proposed *extracting* middleware
to narrow core to YAML plus `function`; what exists is an addition alongside it.

**Why this is a principle question:** the
[extension model review](SPIKE-EXTENSION-MODEL.md) rejected an earlier design
for exactly this reason — two ways to protect a route would drift apart — and
resolved it by removing one. The same test applies here.

**Options:** deprecate the native array on a stated timeline and complete the
extraction; or keep both and document precisely when each is correct, treating
the extension as a bounded variant rather than a successor.

**Recommendation:** decide explicitly and write the answer into both
repositories. Either is defensible; leaving both undescribed is not.

## 4. Where the backlog lives

**Today:** [next steps](NEXT-STEPS.md) holds roughly thirty tracked items
across nine phases. The repository has one open issue (#58). `AGENTS.md`
instructs contributors and agents to file what they find as issues on the
owning repository.

**The contradiction:** the instruction points at the issue tracker; the actual
plan is a Markdown file that no tracker reflects. A plan document also has no
state, so items stay written as future work after they ship — which is how
route-level `auth` came to be described as an invented field in merged agent
guidance (see item 7).

**Options:** move the phase items into issues and keep the document as the
narrative that links them; or keep the document as the system of record and
amend `AGENTS.md` to say so.

**Recommendation:** issues for items, document for sequence. It is the only
arrangement where "done" is recorded automatically.

## 5. Gate the business suite on evidence

**Today:** [the business suite spike](SPIKE-BUSINESS-SUITE.md) proposes seven
applications. [Project direction](PROJECT-DIRECTION.md) states the evidence
test: the framework grows from measured repetition, not from a list of things
applications might need. Phase 6 of [next steps](NEXT-STEPS.md) says candidate
areas are built only when the repetition log shows them repeating. The
repetition log does not exist yet, and the Phase 0 agent benchmark has not been
run.

**Recommendation:** record on the spike itself that it is gated behind the
benchmark and the repetition log, or amend the evidence test. Holding both
positions unannotated makes the stated principle decorative.

## 6. Finish the documentation move, or describe the split

**Today:** `AGENTS.md` states that urlcode-docs is the documentation home and
the only place readers are sent, that new reader-facing pages go there, and
that pages still under `docs/` here are being migrated. Roughly forty
reader-facing pages remain in this repository, several duplicated in
urlcode-docs.

**Observed consequence:** the same fact drifts between copies. The public
documentation site carried the correct trusted-by-default contract while
`docs/OPERATIONS.md` in this repository still described functions as untrusted
and isolated by default. <!-- trust-model-prose: historical -->

**Options:** finish the migration against a dated list; or state which pages
stay here permanently and why, and add a check that fails when a new
reader-facing page appears beside them.

## 7. A review window, and a check that does not need one

**Today:** [governance](../GOVERNANCE.md) records one maintainer, a required
approval count of zero, and that "an independent human review is not yet
guaranteed". Pull requests and CI are mandatory; a second pair of eyes is not.

**What that permitted, concretely:** on 2026-09-19, three coordinated pull
requests (urlcode#158, urlcode-template#6, urlcode-docs#17) opened and merged
within nine minutes. They recorded a genuine improvement — the declarative-first
principle, propagated to every copy in one change — and alongside it the
statement that agents must "never invent an `auth` field". Route-level `auth` is
implemented: it is defined in `schemas/urlcode.schema.json` as a short form
expanding to `policies.extensions.auth`, expanded in `src/config.ts`, typed in
`src/types.ts`, and asserted in `test/recipes.test.ts`. The guidance now
instructs agents away from a supported declarative short form and toward the
lower-level policy form — the opposite of the principle the same change
introduced — in the generated project guide, the bundled starter, both
authoring skills, the packaged plugin skill and the two generated `llms` files.

Nothing failed. Lint, typecheck, generated-resource checks, the package smoke
test and 501 tests all passed, because no check compares what the guidance
claims against what the schema implements.

**The check, now implemented.** `scripts/check-guidance-claims.ts` runs inside
`npm run check` and exits non-zero on a contradiction between agent-facing
guidance and the schema, so this class of error fails CI instead of depending on
a reviewer's attention:

- Inputs: the agent-facing surfaces — `src/agents-guide.ts`,
  `starters/default/AGENTS.md`, `skills/urlcode/SKILL.md`,
  `.claude/skills/*/SKILL.md`, `packaging/claude-plugin/skills/*/SKILL.md`,
  `llms.txt`, `llms-full.txt`, `docs/AI-AUTHORING.md`.
- Assertion one: every YAML field named as valid in those files resolves in
  `schemas/urlcode.schema.json`. A guidance file may not teach a field the
  schema does not accept.
- Assertion two, the one that would have caught this: no field that the schema
  *does* define is described as unsupported, invented or nonexistent. Match the
  negative phrasings deliberately ("never invent", "does not exist",
  "unsupported field") within a short window of a schema-resolvable field name.
- Assertion three: handlers listed as available match the capability catalog,
  so a removed handler (`link`, extracted to `urlcode-dynamic-link` in
  `f7dbe54`) cannot linger in generated guidance.
- Exits non-zero on violation, with a documented `<!-- guidance-claims: ignore -->`
  marker for text that is deliberately about another version. Verified against
  both regressions: reintroducing the "never invent an `auth` field" sentence
  fails the check, and adding the removed `link` handler to the inventory line
  fails it.

What remains a decision: whether `npm run check` membership is enough, or the
check should also be named in the repository's required status checks so it
cannot be bypassed.

**Recommendation:** the check is in; keep it required. It is the part that does
not depend on a person being available. Whether to
also raise the required approval count is a separate call, and
[governance](../GOVERNANCE.md) already states the condition — when the trusted
maintainer team grows.

## 8. One publishing convention

**Today:** `urlcode-dynamic-link` and `urlcode-middleware` keep
`"private": true` on their main branch and drop it in the release commit;
`urlcode-auth`, `urlcode-admin` and `urlcode-ui` do not. All are published.
Both practices are defensible; having both means the flag no longer indicates
publication state.

**Recommendation:** pick one and state it where release process is documented.

## 9. Adjudicate the vendored skill drift

**Today:** `npm run check:downstream-skills` reports that `urlcode-template`'s
vendored authoring and operations skills differ from core's current `main` by
79 and 91 lines. The report is advisory by design and never fails, because a
downstream repository can correctly pin an older published core version
([issue 155](https://github.com/jimhoyd-com/urlcode/issues/155)).

**What is missing:** the judgment the report defers. No one has read the two
diffs and recorded which side is right for the template's `0.4.0-alpha.1` pin.

**Recommendation:** review both diffs once, record the verdict, and re-run the
report when the template repins.
