# Working on URLCode

- Read CONTRIBUTING.md, SECURITY.md and the implemented specification before changes.
- The license is undecided. Do not add a license, SPDX identifier, CLA/DCO, publish
  a package or imply stable production readiness without an explicit decision.
- Keep the free runtime useful and portable. Cloud comes after free launch and
  stability. Do not add provider infrastructure settings to route behavior YAML.
- Treat all application code as untrusted. Preserve WASM isolation, explicit
  project capabilities and external revision-pinned grants; never add a host-code
  execution fallback or commit credentials/customer data.
- Work on a branch and use a pull request. Main is protected: do not direct-push,
  force-push, weaken rules, bypass required checks or auto-approve reviews.
  Merge only within user authorization and after required checks pass.
- Run relevant regression tests and npm run verify for code changes. Run
  npm run test:package for packaging/CLI/starter changes. Schema edits require
  npm run docs:reference and executable examples. Let container changes pass CI.
- Preserve unrelated work. Keep the standalone starter aligned when runtime
  behavior or onboarding changes. Private planning/history must stay private.
- Report actual evidence and remaining limitations. CI passing is not an
  independent security review or deployment/soak/recovery proof.
