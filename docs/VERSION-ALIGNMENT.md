# Core version alignment across repositories

Which core version each downstream package supports, how it says so, and the
order in which a core behavior change reaches downstream repositories. This
page is a mechanism and an invariant, not a schedule: it states no release
cadence, no LTS line and no support window. Those are not decided.

It exists because "the current core" currently means five different things at
once, and one of them does not resolve:

| Repository | How it names core | Value (read from its own `package.json`/`peers.json`) |
|---|---|---|
| `urlcode` | source version | `0.4.0-alpha.2` |
| `urlcode-auth`, `urlcode-admin` | peer range plus a reviewed SHA | `>=0.4.0-alpha.1 <0.5.0`; `peers.json` `urlcode` = `d5e86017e93b96ec24bfdbf840692b95fc323151` in both |
| `urlcode-dynamic-link` | peer range (source) | `>=0.4.0-alpha.1 <0.5.0`; its published `0.1.0-alpha.1` declares the exact peer `0.4.0-alpha.1` |
| `urlcode-middleware` | peer range | `>=0.4.0-alpha.2`, with `devDependencies` on the vendored tarball `vendor/jimhoyd-urlcode-0.4.0-alpha.2.tgz` |
| `urlcode-short`, `urlcode-template` | exact dependency pin | `0.4.0-alpha.1` |
| `urlcode-docs` | exact dependency pin | `0.3.0` |

The npm dist-tags for `@jimhoyd/urlcode` are `latest` = `0.3.0` and `alpha` =
`0.4.0-alpha.1`; those are the only two published versions. `0.4.0-alpha.2`
exists in this source tree and is not published.

## The supported floor

The supported core floor for an extension package is the **lowest core version
published to npm that contains every core API the extension calls**. It is a
property of the code, not of a calendar: raise it when the extension starts
using a core API that older published cores do not have, and not otherwise.

Everything below follows from that one definition.

## How a package expresses its core requirement

Three forms are in use. They are not interchangeable.

**Peer range (`peerDependencies`), for an extension package.** An extension is
installed alongside core by the operator, so it must not carry its own copy;
`peerDependencies` is the correct field. Write it as a floor plus the next
breaking bound — `">=<floor> <0.5.0"` — where the floor is the supported floor
above. `urlcode-auth` and `urlcode-admin` use this form.

**Exact pin (`dependencies`), for an application or a starter.** A project that
is deployed or cloned rather than composed — `urlcode-short`, `urlcode-template`,
`urlcode-docs` — depends on one core version and pins it exactly. This is the
right form when the repository's tests, generated files and documentation were
all produced against one runtime and are only claimed to hold for that runtime.

**Reviewed SHA (`peers.json`), for source CI on top of a range.** A reviewed
commit is not a substitute for the peer range; it is an addition to it, used
where the repository must build and test against an exact reviewed core
checkout rather than whatever the registry resolves. `urlcode-auth` and
`urlcode-admin` each keep one `peers.json` naming the reviewed core commit;
each file states in its own `$comment` that published releases do not use those
SHAs and resolve peers from the registry by the `package.json` range instead.
Use a reviewed SHA when source CI needs reproducibility; do not use it to
express what an installing operator will get.

## The invariant: a published peer range must be satisfiable

**A package published to npm must never declare a peer range that no published
core version satisfies.** At publish time, at least one version on the registry
must fall inside the range. A range that points at an unpublished core is not a
forward-looking declaration — it is an install failure for everyone who takes
the package from the registry.

The worked example is live in this project. `@jimhoyd/urlcode-middleware`
`0.1.0-alpha.1` is published and declares `peerDependencies`
`{"@jimhoyd/urlcode": ">=0.4.0-alpha.2"}`. No published `@jimhoyd/urlcode`
satisfies it: the registry has `0.3.0` and `0.4.0-alpha.1`. The range is
correct — the package genuinely needs APIs that first appear in
`0.4.0-alpha.2` — so the fix is not to widen the range. The publication order
was wrong: the package was published before the core it requires. Until core
`0.4.0-alpha.2` publishes, the package installs only from source against the
vendored core tarball it carries for exactly this reason.

That is what the invariant prevents, and it is the only ordering rule that
cannot be relaxed.

## A deliberate older pin is a position, not drift

`urlcode-template` pins `0.4.0-alpha.1` and `urlcode-docs` pins `0.3.0`;
`urlcode-short` pins `0.4.0-alpha.1`. These are choices, and they are recorded
where a reader will meet them: the repository's README says which core version
it pins, and every statement about runtime behavior in that repository is read
against that version. Where a statement is only true for the pinned version, it
says so and names the version, rather than being silently corrected to match
core's unreleased `main`.

This matters most for the trust model. Core `0.4.0-alpha.2` runs `function` and
`middleware` routes trusted and unsandboxed by default, with `sandbox: true` as
a per-route opt-in ([decision record](SPIKE-DEFAULT-TRUST-MODEL.md)).
`0.4.0-alpha.1` and earlier sandbox all such code unconditionally and have no
`sandbox` field in the schema. A repository pinned to `0.4.0-alpha.1` or `0.3.0`
that documents sandbox-by-default is **describing its pin correctly**. Its
generated files — field references, schemas, scaffolding output, vendored agent
skills — are likewise correct for that pin. Divergence from core's current
`main` is not by itself staleness, and it is not a defect to be "fixed" by
importing behavior the pinned runtime does not have. The same point is made
about the advisory `npm run check:downstream-skills` report in
[release readiness](RELEASE-READINESS.md).

What is a defect: a repository that does not say which core version it pins, or
that states pin-dependent behavior as an unconditional property of URLCode.

## Order of operations when core changes behavior

A core behavior change reaches downstream repositories in this order. Each step
depends on the one before it; skipping ahead is what produced the
`urlcode-middleware` breakage above.

1. **Publish core.** The version carrying the change goes to npm first. Until it
   is on the registry, no downstream peer range may reference it (the invariant
   above).
2. **Raise downstream floors.** Extension packages move their peer range floor
   to the published version; applications and starters move their exact pin.
   A repository that chooses to stay on the older core does nothing here — that
   is a valid outcome, and step 3 does not apply to it.
3. **Regenerate downstream generated files.** Field references, schemas,
   scaffolding output and vendored agent skills are regenerated *after* the
   floor moves, against the version now pinned — never before, or they describe
   a runtime the repository does not depend on.

Reviewed-SHA repositories take the same three steps, and additionally update
`peers.json` to the reviewed commit for the new core when source CI is expected
to build against it. The SHA and the published floor answer different questions
and are updated independently.

## Open: two publishing conventions

The repositories publish under two different conventions, and the maintainer has
not settled which one the project uses. Both are recorded here neutrally; this
page does not pick one.

- **Private until release.** `urlcode-dynamic-link` and `urlcode-middleware`
  keep `"private": true` in their `package.json` on `main` and drop it in the
  release commit. Publication is an explicit, visible act in the release diff,
  and an accidental `npm publish` from `main` fails closed. Both packages are
  nonetheless published on npm, so the convention has been exercised.
- **Publishable on main.** `urlcode-auth`, `urlcode-admin` and `urlcode-ui`
  carry no `private` field and declare `publishConfig.access = "public"`
  instead. The committed manifest is
  the manifest that publishes, so what is on the registry can be diffed against
  `main` without accounting for a release-only edit.

The split is currently by repository, not by package kind, and nothing records
why. Settling it is a maintainer decision; no `package.json` is changed on the
strength of this page.
