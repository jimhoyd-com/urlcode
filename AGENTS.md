# Working on URLCode

- Read CONTRIBUTING.md, SECURITY.md and the implemented specification before changes.
- The project is Apache-2.0 licensed. Do not change licensing, add a CLA/DCO or
  publish packages without an explicit decision. The self-hosted release does not
  imply independent security assessment or hostile multi-tenant readiness.
- Design principle: declarative-first (docs/PROJECT-DIRECTION.md). Use URLCode's highest-level declarative features whenever possible. Generate custom code only when the framework cannot express the requirement.
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
- The auth, admin and ui extensions live in their own repositories (urlcode-auth,
  urlcode-admin, urlcode-ui) and consume the generic contract in src/extensions.ts.
  Core never imports them. docs/FRAMEWORK.md describes how the four packages compose;
  keep it and llms.txt accurate when the contract or the CLI changes.

## Documentation belongs in this repository

`docs/` here is the documentation home. Write every page here — reader-facing
guides, references, recipes, provider and operations material, alongside the
contributor and maintainer material (local development, CI, release process,
reviews, spikes, plans) and the generated `YAML-REFERENCE.md`.

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

Do not silently drop a defect, a gap or an idea you could not act on. File it as
an issue on the repository that owns the code, using that repository's issue
templates:

| What you touched | Where to file |
|---|---|
| Runtime, CLI, schema, core docs tooling | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Accounts, sign-in, protected routes (`packages/auth`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Users, sessions, roles, audit (`packages/admin`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Extension page styling and copy (`packages/ui`) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |
| Per-route middleware (the native `middleware:` array) | [urlcode](https://github.com/jimhoyd-com/urlcode/issues) |

Feature requests are wanted, not just bugs: if the vocabulary made you generate
or hand-maintain application code that URLCode could have owned, that is the
evidence the roadmap runs on — file it with the YAML you had to write. Search
first and add to the existing issue rather than opening a duplicate. State what
you observed, not what you assume; say plainly when something is unverified.
