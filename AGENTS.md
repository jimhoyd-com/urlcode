# Working on URLCode

- Read CONTRIBUTING.md, SECURITY.md and the implemented specification before changes.
- The project is Apache-2.0 licensed. Do not change licensing, add a CLA/DCO or
  publish packages without an explicit decision. The self-hosted release does not
  imply independent security assessment or hostile multi-tenant readiness.
- Design principle: declarative-first (docs/PROJECT-DIRECTION.md). Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement.
- Implementation-portability directive: implement the behavioral contract, not a TypeScript translation. When changing a major core semantic seam, update its card in docs/RUNTIME-IMPLEMENTATION.md, the authoritative semantic page and focused fixture. Keep implementation-agent instructions and source maps outside `src/`: type stripping preserves source comments in `dist/`. A runtime/target that cannot enforce a capability must refuse it before serving; trusted Node functions and `sandbox: true` are separate execution modes, not a cross-language guest-code promise.
- Keep the free runtime useful and portable. Do not add provider
  infrastructure settings to route behavior YAML.
- `function`/`middleware` routes are trusted and run unsandboxed (in-process,
  full Node access) by default; `sandbox: true` opts a route into the isolated
  QuickJS/WASM worker pool (docs/SPIKE-DEFAULT-TRUST-MODEL.md,
  docs/FUNCTION-SECURITY.md). Preserve that sandboxed path's isolation exactly
  as-is for any route that declares it, preserve explicit project capabilities
  and external revision-pinned grants, and never commit credentials/customer
  data.
- Work on a branch and use a pull request. Main is protected: do not direct-push,
  force-push, weaken rules, bypass required checks or auto-approve reviews.
  Merge only within user authorization and after required checks pass.
- The runtime source is TypeScript run through Node's type stripping; keep
  npm run typecheck green and never commit dist (npm run build emits it).
- Run relevant regression tests and npm run verify for code changes. Run
  npm run test:package for packaging/CLI/starter changes. Schema edits require
  npm run docs:reference and executable examples. Let container changes pass CI.
- Preserve unrelated work. Keep the standalone starter aligned when runtime
  behavior or onboarding changes.
- Report actual evidence and remaining limitations. CI passing is not an
  independent security review or deployment/soak/recovery proof.
- The ui, audit, abuse, mail, auth, admin, store, forms, form-records and mcp extensions are workspace packages in this repository
  (packages/ui, packages/audit, packages/abuse, packages/mail, packages/auth, packages/admin, packages/store, packages/forms, packages/form-records, packages/mcp) and consume the generic contract
  in packages/core/src/extensions.ts. Core still never imports them: consolidating the
  packages into one repository did not make the dependency two-way, and a core
  change must not reach for a package. The packages that depend on core resolve
  it to this checkout rather than the registry, which
  scripts/check-workspace-links.ts asserts. Their prose links locally too: the
  urlcode-ui, urlcode-auth and urlcode-admin repositories are retired, so
  Markdown pointing at one of them, or at a relative path that does not exist,
  fails scripts/check-local-links.ts — label genuinely historical release
  evidence with `<!-- local-links: historical -->` rather than rewriting it.
  docs/FRAMEWORK.md describes how the eleven packages compose; keep it and
  llms.txt accurate when the contract or the CLI changes. Current version
  numbers live in the manifests and docs/VERSION-ALIGNMENT.md; do not copy them
  into other prose, which is how they went stale before.

## Public documentation belongs in this repository

`docs/` here is the public documentation home. Write reader-facing guides,
references, recipes, provider and operations material, contributor instructions
and the generated `YAML-REFERENCE.md` here. Keep private strategy, internal
research and detailed dated maintainer reviews in the private maintainer
repository; those notes never replace an implemented public contract.

- Follow [the documentation maintenance rules](CONTRIBUTING.md#maintain-existing-pages-first):
  search for an existing home before creating a page, link to authoritative
  facts rather than copying them, and put routine task reports in the PR.
- A code change that alters behavior a reader depends on is not finished until
  the matching page in `docs/` is updated. Do it in the **same** pull request,
  so review sees both halves and neither can land alone.
- Do not open a documentation pull request against another repository for
  content that belongs here.
- `urlcode-docs` is **deleted** (2026-09-19). It held its own copy of most of
  these pages and had drifted from them; it was retired rather than reconciled
  page by page. Every `github.com/jimhoyd-com/urlcode-docs` URL now 404s, and
  there is nothing to open a pull request or issue against. Anything in it that
  was ahead of this repository was brought across before it went.

## File what you find

GitHub Issues are the sole tracker for actionable defects, gaps, ideas and
follow-up work. Do not create or retain repository-local issue files, backlogs,
or duplicate issue bodies. Benchmark and other evidence may link to its GitHub
issue, but must not copy the issue body into the repository. Do not silently
drop a defect, a gap or an idea you could not act on. File it as an issue on the
repository that owns the code, using that repository's issue templates:

| What you touched | Where to file |
|---|---|
| Runtime, CLI, schema, core docs tooling | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Accounts, sign-in, protected routes (`packages/auth`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Users, sessions, roles, the audit screens (`packages/admin`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| The audit log, its outbox contract and CLI (`packages/audit`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Rate budgets, backoff, challenges (`packages/abuse`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Email templates and transports (`packages/mail`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Extension page styling and copy (`packages/ui`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Forms-to-store composition (`packages/form-records`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Per-route middleware (the native `middleware:` array) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |

Feature requests are wanted, not just bugs: if the vocabulary made you generate
or hand-maintain application code that URLCode could have owned, that is the
evidence the roadmap runs on — file it with the YAML you had to write. Search
first and add to the existing issue rather than opening a duplicate. State what
you observed, not what you assume; say plainly when something is unverified.
