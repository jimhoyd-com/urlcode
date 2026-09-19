# Core version alignment across repositories

Which core version each downstream package supports, how it says so, and the
order in which a core behavior change reaches downstream repositories. This
page is a mechanism and an invariant, not a schedule: it states no release
cadence, no LTS line and no support window. Those are not decided.

It exists because "the current core" had come to mean five different things at
once, and one of them did not resolve. The `0.4.0-alpha.2` release closes that;
the table below is where every repository lands, and it is the register to
change whenever a version changes anywhere.

| Repository | How it names core | Value (read from its own `package.json`/`peers.json`) |
|---|---|---|
| `urlcode` | source version | `0.4.0-alpha.2` |
| `urlcode-auth`, `urlcode-admin` | peer range plus a reviewed SHA | `>=0.4.0-alpha.2 <0.5.0`; `peers.json` `urlcode` = `d5e86017e93b96ec24bfdbf840692b95fc323151` in both |
| `urlcode-dynamic-link` | peer range (source); published `0.1.0-alpha.1` declares the **exact** peer `0.4.0-alpha.1` | retiring — folded into `urlcode-short`, then both go |
| `urlcode-middleware` | peer range | `>=0.4.0-alpha.2 <0.5.0` |
| `urlcode-template` | exact dependency pin | `0.4.0-alpha.2` |
| `urlcode-docs` | exact dependency pin | **archived 2026-09-19** — pinned `0.4.0-alpha.2`; retired with `urlcode-short` and `urlcode-dynamic-link` |
| `urlcode-short` | exact dependency pin | retiring — stays on its published `0.4.0-alpha.1` pin |

Every package that is staying requires `0.4.0-alpha.2` specifically, because
`ExtensionActivation.root` first appears there: `urlcode-middleware` also needs
the `middleware()` extension hook and `RuntimeExtension.cacheSensitive`, while
`urlcode-auth` and `urlcode-admin` resolve project-level lifecycle hooks
through `root`.

`urlcode-admin` additionally declares `@jimhoyd/urlcode-ui >=0.1.0-alpha.5`,
where `urlcode-ui`'s **hand-copied** `ExtensionActivation` first carries `root`.
A package that copies another package's types rather than importing them puts a
second, independent floor in play, and it moves on that package's release
schedule rather than core's.

The npm dist-tags for `@jimhoyd/urlcode` are `latest` = `0.3.0` and `alpha` =
`0.4.0-alpha.2`. `latest` deliberately stays on the `0.3.0` Apache-2.0
self-hosted baseline: the `0.4.0` line is a prerelease and must not become the
default install. Every release workflow derives its dist-tag from the version
rather than defaulting, so a prerelease can only publish under `alpha`.

The sibling packages are `@jimhoyd/urlcode-ui` `0.1.0-alpha.5`,
`@jimhoyd/urlcode-auth` and `@jimhoyd/urlcode-admin` `0.1.0-alpha.3`, and
`@jimhoyd/urlcode-middleware` `0.1.0-alpha.2`. For the extension line, `latest`
and `alpha` point at the same version — see the second invariant below.

`@jimhoyd/urlcode-dynamic-link` and `@jimhoyd/urlcode-short` are **retired**:
both were unpublished from npm and their repositories deleted on 2026-09-19, so
neither took a further version and both ended at their published
`0.1.0-alpha.1`. `urlcode-docs` was archived with them on 2026-09-19. This
leaves one sharp edge worth stating: dynamic-link's `0.1.0-alpha.1` declares
the *exact* peer `@jimhoyd/urlcode: 0.4.0-alpha.1`, so it cannot be installed
alongside core `0.4.0-alpha.2` at all, and no later release will fix that.
Anything still depending on it has to absorb the code rather than resolve the
package.

Every one of those is a new version in this release. Each package's previous
release sat at the same version number as a source tree that had moved well
past it — 43 merged commits in `urlcode-auth`, 40 in `urlcode-ui`, 28 in
`urlcode-admin` — so the published version number identified nothing. A
version number that does not change when the source does is the same class of
defect as a peer range that cannot resolve, and the rule is the same: change
the version in the pull request that changes the source.

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
is deployed or cloned rather than composed — `urlcode-template` — depends on
one core version and pins it exactly. This is the
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

The worked example came from this project. `@jimhoyd/urlcode-middleware`
`0.1.0-alpha.1` was published declaring `peerDependencies`
`{"@jimhoyd/urlcode": ">=0.4.0-alpha.2"}` at a time when the registry held only
`0.3.0` and `0.4.0-alpha.1`, so nothing satisfied it. The range was correct —
the package genuinely needs APIs that first appear in `0.4.0-alpha.2` — so the
fix was never to widen the range. The publication order was wrong: the package
was published before the core it requires, and it could be installed only from
source against a vendored core tarball carried for exactly that reason.

Publishing core `0.4.0-alpha.2` resolves it without any change to the already
published package: the range becomes satisfiable the moment core is on the
registry. The vendored tarball and the source-only install path go away with
it.

That is what the invariant prevents, and it is the only ordering rule that
cannot be relaxed.

## The second invariant: `latest` must not fall below a sibling's floor

**Where a package line publishes under a prerelease dist-tag, `latest` must
still resolve to a version that satisfies every peer floor its siblings
declare.** `latest` is what a plain `npm install <package>` resolves, so a
`latest` left behind hands the installing operator a build that another
package in the same install refuses.

The worked example, again live in this project: `@jimhoyd/urlcode-auth`
published `alpha` = `0.1.0-alpha.2` while leaving `latest` = `0.1.0-alpha.1`.
`@jimhoyd/urlcode-admin` declares a peer floor of `>=0.1.0-alpha.2` on auth, so
`npm install @jimhoyd/urlcode-auth` resolved a build below the floor admin
requires. Nothing in the source is wrong; the dist-tag is.

The fix is a registry operation rather than a source change:

```sh
npm dist-tag add @jimhoyd/urlcode-auth@0.1.0-alpha.2 latest
```

Core is the deliberate exception. Its `latest` stays on `0.3.0` because no
sibling declares a floor above it — the extension packages name core through
`peerDependencies`, which resolve by range and never by dist-tag.

## The third invariant: verify against the floor, not against the newest

**A declared floor is a promise that the package compiles and works against
that exact version, so that is the version to verify against.** Testing against
the newest sibling proves nothing about the range's lower bound, which is what
an installing operator can actually resolve.

`urlcode-auth` and `urlcode-admin`'s release workflows already encode this:
they read each `peerDependencies` range, install the peer at its floor, and
typecheck. That gate caught a real error. Both packages declared core
`>=0.4.0-alpha.1` while their source resolved project-level lifecycle hooks
through `ExtensionActivation.root`, which does not exist before
`0.4.0-alpha.2`. The code had required the newer core since those hooks merged;
only the range still said otherwise, and a review that checked the newest core
saw nothing wrong.

Two consequences worth stating:

- **Raising a floor is a narrowing change, and that is the point.** An operator
  below the new floor gets an unmet-peer error at install instead of a failure
  at activation. The previous range promised support that did not exist.
- **A copied type is a second floor.** `urlcode-ui` hand-copies core's
  extension types rather than importing them, so `urlcode-admin` needs a
  `urlcode-ui` version whose *copy* carries `root` — `0.1.0-alpha.5` — quite
  separately from which core it needs. Copying a type couples you to the
  copier's release schedule as well as the original's.

A repository whose release workflow lacks this gate is not exempt from the
rule, only from having it enforced. `urlcode-middleware` has no floor-install
step today, so its floor is maintained by hand against the same definition.
(`urlcode-dynamic-link` and `urlcode-short` had none either, and are now
retired.)

## A deliberate older pin is a position, not drift

`urlcode-template` pins `0.4.0-alpha.2`, so no downstream repository that is
staying is currently behind. An older pin
remains a legitimate position, and the rule for it does not change: it is
recorded where a reader will meet it. The repository's README says which core
version it pins, and every statement about runtime behavior in that repository
is read against that version. Where a statement is only true for the pinned version, it
says so and names the version, rather than being silently corrected to match
core's unreleased `main`.

This matters most for the trust model. Core `0.4.0-alpha.2` runs `function` and
`middleware` routes trusted and unsandboxed by default, with `sandbox: true` as
a per-route opt-in ([decision record](SPIKE-DEFAULT-TRUST-MODEL.md)).
`0.4.0-alpha.1` and earlier sandbox all such code unconditionally and have no
`sandbox` field in the schema. This is why moving a pin to `0.4.0-alpha.2` is
a behavior change even when no YAML changes: every `function`/`middleware`
route that does not declare `sandbox` becomes trusted on upgrade. Review those
routes before raising a pin, and add `sandbox: true` to the ones that handle
input or code you would not trust with full Node/filesystem/network access.
A repository still pinned to `0.4.0-alpha.1` or `0.3.0` that documents
sandbox-by-default is **describing its pin correctly**. Its
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

## Settled: every package is publishable from `main`

The repositories used to publish under two different conventions. The
maintainer settled it on 2026-09-19: **every package carries no `private` field
and declares `publishConfig.access = "public"`.** The committed manifest is the
manifest that publishes, so what is on the registry can be diffed against
`main` without accounting for a release-only edit.

`urlcode-dynamic-link` and `urlcode-middleware` were the two exceptions. They
kept `"private": true` on `main` and dropped it in the release commit, which
made publication an explicit act in the release diff and made an accidental
`npm publish` from `main` fail closed. The cost outweighed that: the release
workflow refuses to build a private package, so `main` was never publishable as
it stood, and the manifest under review was never the manifest that shipped.
Both now match `urlcode-auth`, `urlcode-admin` and `urlcode-ui`.

The protection the old convention offered is not lost, it is just enforced
somewhere better: publication is gated on a `v*` tag whose commit is already an
ancestor of `main`, on the tag agreeing with `package.json`, and on the
`PUBLISH_NPM` repository variable. A stray `npm publish` from a working copy is
not what those gates are guarding against, and a `private` flag was never the
thing standing between `main` and the registry.
