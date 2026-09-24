# Repository automation

This directory contains repository-maintenance automation, not installed runtime
code. The root package remains the public npm package; `scripts/` is excluded
from its archive, including the generated `dist/scripts/operational-drills.js`
build output, which CI runs directly from the checkout's own `dist/` after
`npm run build` and which a published package never needs.

Run supported tasks through the named npm scripts in [`package.json`](../package.json)
and follow [repository CI](../docs/CI.md#checking-this-repository) and
[release operations](../docs/RELEASE-OPERATIONS.md) for the
required checks and release procedure. Direct invocation is appropriate only
where the command is documented or a workflow does so deliberately.

## Map

| Area | Scripts |
| --- | --- |
| Build and package | `build.ts`, `build-candidate.ts`, `pack-json.ts`, `pack-sources.mjs`, `package-audit.ts`, `package-smoke.ts`, `supply-chain-triage.ts` |
| Documentation and agent resources | `build-cookbook-index.ts`, `build-llms-full.ts`, `generate-agent-assets.ts`, `generate-claude-plugin.ts`, `generate-yaml-reference.ts`, `check-guidance-claims.ts`, `check-local-links.ts`, `check-trust-model-prose.ts`, `check-version-statements.ts`, `sync-agent-lists.ts` |
| Repository and CI checks | `check.ts`, `check-core-boundaries.ts`, `check-issue-labels.ts`, `check-release-tags.ts`, `check-workspace-links.ts`, `ci-history.ts`, `ci-plan.ts`, `ci-report.ts`, `nul-scan.ts`, `operational-drills.ts`, `workerd-parity.ts` |
| Extension artifacts | `create-extension.ts`, `prepare-artifacts.ts`, `prepare-extension-bundles.ts`, `verify-extension-bundles.ts` |
| Release and distribution | `npm-command.ts`, `peer-api.ts`, `prepare-core-release.sh`, `prepare-release-train.ts`, `release.ts`, `release-artifacts.ts`, `release-identity.ts`, `release-installability.ts`, `release-prepare.ts`, `release-run.ts`, `release-template.ts`, `render-homebrew.ts` |

## Placement and compatibility

Existing root-level filenames are established automation entry points. They are
called by workflows, npm scripts, release helpers, tests and documented
operator commands, so do not move or rename them merely to make this listing
tidier. A move needs an explicit compatibility audit of all of those callers
and a focused migration change.

For new, standalone scripts, use the area as the first directory segment when
it improves local cohesion: `scripts/build/`, `scripts/check/`, `scripts/docs/`
or `scripts/release/`. Keep a stable npm command as the user-facing entry point
and use paths relative to the repository root in workflow commands. Place a
small helper beside the script it serves when it is not independently runnable.
Update this map in the same change as any new top-level automation entry point.
