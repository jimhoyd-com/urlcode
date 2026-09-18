# Working on URLCode

- Read CONTRIBUTING.md, SECURITY.md and the implemented specification before changes.
- The project is Apache-2.0 licensed. Do not change licensing, add a CLA/DCO or
  publish packages without an explicit decision. The self-hosted release does not
  imply independent security assessment or hostile multi-tenant readiness.
- Keep the free runtime useful and portable. Do not add provider
  infrastructure settings to route behavior YAML.
- Treat all application code as untrusted. Preserve WASM isolation, explicit
  project capabilities and external revision-pinned grants; never add a host-code
  execution fallback or commit credentials/customer data.
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
