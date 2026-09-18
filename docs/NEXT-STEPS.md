# Next steps: closing the gaps

Status: plan written 2026-09-18 from the cleanup and the
[usability review](USABILITY-REVIEW.md). Each item says what it fixes, where
the work is, how it is proven, and its size (S: a day, M: a week, L: more).
Order inside a phase is the recommended sequence; phases can overlap. The
[roadmap](../ROADMAP.md) owns what ships; this page owns how the gaps close.

## Phase 1: make the ladder real (highest leverage, no contract changes)

### 1.1 Publish the three extension packages (decision, S)

Fixes: every install step in the "add accounts" row of the usability review
except the revision pin. Today a person or an agent must clone three private
repositories, run `pack-sources.mjs` with four paths and a SHA, and install
four tarballs.

- Decide: publish `@jimhoyd/urlcode-ui`, `-auth`, `-admin` as `0.1.0-alpha.N`
  to npm with provenance, from tags on `main`, keeping the "private until
  reviewed" caveats in each README and status file. Alpha on npm is a
  distribution channel, not an endorsement; the caveats say so.
- Work: copy core's `release.yml` shape into each repo (candidate build, npm
  audit, `npm pack`, attest, publish behind a repository variable). Drop
  `"private": true` only in the release commit. Pin `peerDependencies` to
  real ranges (`@jimhoyd/urlcode >=0.4.0 <0.5` once 1.4 below ships).
- Proof: a clean directory does `npm install @jimhoyd/urlcode @jimhoyd/urlcode-auth`
  and runs `urlcode-auth init`, `bootstrap`, `serve`; the admin repo's
  `scripts/clean-project-acceptance.mjs` runs against the published tarballs.
- Keep `pack-sources.mjs` for reviewed-source installs; it stops being the
  documented first path.

### 1.2 One place for peer revisions (S)

Fixes: three disagreeing lists of "verified peer commits" (the CI workflows,
`ACCEPTANCE.md` in auth and admin, the pack script's core-revision check).

- Work: add `peers.json` to auth and admin (`{ "urlcode": "<sha>", "urlcode-ui": "<sha>" }`);
  the workflows read it with one `jq` step instead of hard-coded `ref:` values;
  `pack-sources.mjs` defaults `--core-revision` from it; `ACCEPTANCE.md` links
  to it instead of copying SHAs. A tiny test asserts the file parses and the
  SHAs are 40 hex characters.
- Proof: CI green after the change; bumping a peer is a one-line diff.
- Once 1.1 ships, replace SHAs with published versions and delete the file.

### 1.3 `urlcode init --with auth,admin,ui` (M, core plus small changes in each extension)

Fixes: three initializers with three directory conventions; no single command
produces the layered project the framework page describes.

- Work in core (`src/cli.ts`, `src/init.ts` or wherever `init` lives): accept
  `--with a,b,c`; for each name, resolve the installed package
  `@jimhoyd/urlcode-<name>` from the invoking directory and import its
  `scaffold` export (a new, small, documented contract: `scaffold({directory,
  project, hostFile, names}) => { yamlFragment, hostImports, hostEntries,
  readmeSection }`). Core merges fragments into `urlcode.yaml`, writes one
  `host.mjs`, one `README.md` with the ordered next steps, and prints the
  `inspectExtensionRevision` SHA at the end. Missing package: refuse with
  the install command. Core never bundles or imports the packages at build time.
- Work in auth, admin, ui: export `scaffold` built from the existing
  `initAuthentication` / admin `init` / ui pieces. Keep their standalone `init`
  commands, implemented on the same function.
- Proof: a core test with a fake `@jimhoyd/urlcode-demo` package in a temp
  `node_modules`; in each extension repo, a test that `scaffold` output
  validates with core; the admin clean-project acceptance uses the new command.
- Docs: `docs/FRAMEWORK.md` composition section, each README's install section.

### 1.4 Print extension schemas: `urlcode extensions` and MCP (M, core)

Fixes: an agent cannot discover what `extensions.auth.config` accepts without
reading auth's source; `urlcode mcp` cannot serve it.

- Work: `urlcode extensions --host-file … [--json]` loads the host file the
  same way `validate` does, and prints each registration's name, contract
  version, targets, configuration schema and policy schema. Add the same data
  to the read-only SDK (`inspectExtensions(hostFile)`) and an MCP tool
  `extensions.schemas`. The host file is operator code; document that this
  command executes it like `validate` does.
- Proof: test against the `examples/extensions` demo registry; MCP test
  lists the tool and returns the demo schema.
- Docs: `EXTENSIONS.md`, `TOOLING.md`, `AI-AUTHORING.md` capability matrix row.

## Phase 2: fewer lines for the common case (schema additions, `version: "1"` stays valid)

### 2.1 Short form for function routes (M, core)

Fixes: the smallest function route is ten lines; Hono's is one.

- Work: allow `function: functions/hello.mjs` (a string). Expansion rule:
  every `{param}` in the path becomes a required string parameter with
  `minLength: 1, maxLength: 128` and an `args` entry of the same name; the
  long form stays the canonical IR. Implement in the config compiler, not the
  schema alone, so `routes`, `audit` and the field reference show the
  expanded form. Same for `middleware: [functions/x.mjs]` strings.
- Proof: schema and generated reference updated (`npm run docs:reference`),
  cookbook gains a short-form route with fixtures, a test asserts short and
  long forms compile to identical IR, the audit route count is unchanged.
- Docs: YAML guide first example, README example, AI authoring matrix.

### 2.2 Single install channel on the first screen (S, docs)

Fixes: three equal-weight install commands before the first project.

- Work: README keeps `npm install --global`; brew, script and container move
  to `INSTALL.md` (already documented there). Done partly in this cleanup.

## Phase 3: one presentation story (extension repos)

### 3.1 Shared markup helpers move into urlcode-ui (S, ui then auth and admin)

Fixes: `hidden`, `postForm`, `text`/`tr` and a deadline race duplicated in
auth and admin.

- Work: ui contract version 1 addition: `hiddenField(name, value)`,
  `postForm({action, csrf, fields, label, destructive?, icon?})`,
  `withDeadline(fn, ms, message)` in the main entry (Web APIs only). Bump
  nothing else. Auth and admin replace their copies and delete
  `admin-markup.ts` / `admin-deadline.ts`.
- Proof: ui tests for escaping and the timeout path; auth and admin suites
  unchanged in count and green; packed consumer test.

### 3.2 Auth and admin render through the kit (L, ui first, then auth, then admin)

Fixes: the framework says the `ui` extension restyles every page; today auth
and admin take a `presentation` and use the primitives, so a project theme
does not reach them.

- Work: auth exports `authCatalogue` and `authTemplates` (its screens as kit
  templates with declared view models), takes an optional `ui` from the host
  and renders with `ui.kit.page` when present, falling back to the current
  primitives when absent. Admin the same. The ui status file already lists
  this; the runtime's forced `no-store` on extension responses means kit
  assets are not cached, so file the runtime change request for an immutable
  exception on hashed assets first (core, S).
- Proof: ui `doctor` reports full translation coverage for both catalogues;
  each screen's existing HTTP tests pass under both render paths; a browser
  walkthrough with a project theme shows it on the account and admin pages.
- Retire the `presentation` option one minor version after.

## Phase 4: application data (contract question, spike first)

### 4.1 Spike: a declared `collection` handler with an admin view (M to write, L to build)

Fixes: "full-fledged application" today means "site with accounts". Every
competitor on the last rung has a place for the project's own records.

- Write the spike in core `docs/SPIKE-COLLECTIONS.md` against the same
  principles as links: YAML declares a collection with a JSON Schema for its
  records, exact bounded query and mutation routes, operator-owned SQLite,
  no guest queries; admin registers a generic records screen through an
  extension-owned schema; functions receive records as validated `args`,
  never a database handle. The spike must answer: portability to serverless
  targets (refuse or adapter), size limits, migration of the schema, and
  whether links become a collection.
- Decide after review. Nothing is built before the spike is accepted.

## Phase 5: evidence that is still missing (unchanged from issue 58)

These are not code gaps; they are proof gaps, and each needs a person, a
device or an environment the repositories cannot supply.

| Gap | Plan | Owner and size |
|---|---|---|
| Browser and device WebAuthn coverage | Playwright run against `urlcode-auth` with virtual authenticator on Chromium in CI; one manual pass on Safari and Android | auth, M |
| Accessibility assessment | Automated axe pass in the existing browser walkthrough plus one manual screen-reader and forced-colors pass; record findings in each `UX-REVIEW.md` | ui, auth, admin, M |
| Soak, backup and recovery on a deployment | Run `operational-drills` with `URLCODE_SOAK_SECONDS=3600` on a real host; run auth's recovery drill against a restored snapshot; record in `OPERATIONAL-PROOF.md` and `RECOVERY-DRILL.md` | core and auth, M |
| Provider deployments | Deploy `examples/provider-conformance` to one Vercel, one AWS and one Cloudflare account and run `verify-provider`; record in `PROVIDER-VERIFICATION.md` | core, M, needs accounts |
| Live Google, Apple and SES | Deferred by the owner; keep the synthetic signed fixtures and say so | auth, later |
| Independent security review | Use `SANDBOX-REVIEW.md` as the package; commission or invite one reviewer; fix findings before any non-alpha release of auth | all, L, external |

## Phase 6: hardening left from the audit (core, S each)

- Direct tests for the sandbox pool, worker crash recovery and timeout kill
  path (`src/functions.ts`, `src/function-worker.ts`, `src/guest-api.ts`);
  today they are reached only through runtime tests.
- Tests for `src/link-store-worker.ts` behind the WAL gate, so a skipped
  `links.test.ts` still leaves the record path covered (partly done with
  `link-records.test.ts`).
- Re-verify the remaining line-number rows in `STANDARDS.md`; cite symbols.
- Split the three longest reference documents (YAML guide, policies, dynamic
  links) into task pages under 200 lines each, so an agent loads one.
- One `npm run verify` in the extension repos should fail fast with the
  SQLite requirement named, instead of 100 identical `patched_sqlite_required`
  errors: add a pre-test check script.

## Sequence at a glance

```
Phase 1  publish → peers.json → init --with → extensions --schema   (unblocks everything an agent does)
Phase 2  short-form function route → install screen
Phase 3  shared helpers → kit adoption (needs the no-store exception in core)
Phase 4  collections spike, then decide
Phase 5  proof gaps, in parallel, as people and environments allow
Phase 6  hardening, in any gap
```
