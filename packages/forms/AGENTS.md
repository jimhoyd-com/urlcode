# Working on URLCode forms

- Read CONTRIBUTING.md and SECURITY.md first. Core owns the generic extension
  contract (`@jimhoyd/urlcode/extensions`); this package owns bounded,
  server-rendered form flows over the shared `ui` kit.
- Apache-2.0. Do not publish packages by hand. This package is not yet part
  of a signed `extension-bundles@v…` release (`"private": true` in
  `package.json`); do not change that without an explicit decision.
- TypeScript run through Node type stripping; `dist/` is built, never
  committed. Peers are workspace siblings: core and `ui` resolve through the
  `file:../..` and `file:../ui` links that `scripts/check-workspace-links.ts`
  enforces, never from a registry.
- Run `npm run verify` for every change. Escaping, CSRF and admission-bound
  parsing need a regression test in the same PR.
- Never commit credentials or customer data. Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI is not a security review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. Runtime, CLI and
schema, and this extension's page styling and copy, all live in this one
repository now, so file everything against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates.

Feature requests are wanted, not just bugs: if you had to hand-write
application code that the URLCode vocabulary could have owned, that is the
evidence the roadmap runs on.
