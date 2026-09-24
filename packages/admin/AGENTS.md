# Working on URLCode admin

- Read CONTRIBUTING.md, SECURITY.md, THREAT-MODEL.md and IMPLEMENTATION-STATUS.md.
  Privileged mutations go through auth's transactional service, never ad hoc
  database writes. IMPLEMENTATION-STATUS.md is the contract for what shipped;
  the original design spike is private maintainer material.
- Apache-2.0. Do not publish packages or bypass protected main.
- TypeScript through Node type stripping; `dist/` is never committed. Peers
  (`@jimhoyd/urlcode`, `-auth`, `-ui`) are workspace siblings in this
  repository, not registry installs.
- Tests need a Node build with a patched SQLite (3.51.3+, 3.50.7 or 3.44.6).
- Run `npm run verify`. Every permission gate, freshness check and export bound
  needs a test. Keep shared presentation in `@jimhoyd/urlcode-ui`, not copied here.
- No credentials, exports, case evidence or customer data in the repository.
- Report tested commits and remaining deployment and security limitations.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. Runtime, CLI and
schema, accounts and protected routes, users and audit, extension page styling
and copy all live in this one repository now, so file everything against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates.

Feature requests are wanted, not just bugs: if you had to hand-write application
code that the URLCode vocabulary could have owned, that is the evidence the
roadmap runs on — file it with the YAML you had to write. Search first and add to
the existing issue rather than opening a duplicate. State what you observed, not
what you assume, and say plainly what you did not verify.

## Documentation lives in the monorepo

Write guides and references in the root `docs/` directory, alongside core docs.
Keep package contributor and security material accurate. Follow the root
[development and release pipeline](../../docs/DEVELOPMENT-PIPELINE.md) for
the shared version and release.
