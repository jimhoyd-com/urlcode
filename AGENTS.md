# Working on URLCode admin

- Read CONTRIBUTING.md, SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md.
  Privileged mutations go through auth's transactional service, never ad hoc
  database writes. docs/SPIKE-ADMIN.md is the plan, not the contract.
- Apache-2.0. Do not publish packages or bypass protected main.
- TypeScript through Node type stripping; `dist/` is never committed. Peers
  (`@jimhoyd/urlcode`, `-auth`, `-ui`) resolve from local checkouts or tarballs.
- Tests need a Node build with a patched SQLite (3.51.3+, 3.50.7 or 3.44.6).
- Run `npm run verify`. Every permission gate, freshness check and export bound
  needs a test. Keep shared presentation in `@jimhoyd/urlcode-ui`, not copied here.
- No credentials, exports, case evidence or customer data in the repository.
- Report tested commits and remaining deployment and security limitations.
