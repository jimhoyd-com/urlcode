# Working on URLCode form-records

- Read the root [CONTRIBUTING.md](../../CONTRIBUTING.md) and
  [SECURITY.md](../../SECURITY.md) first. Core owns the generic extension
  contract (`@jimhoyd/urlcode/extensions`); this package owns only the
  composition of a forms flow with an owned store collection. It must never
  reimplement forms' rendering, CSRF or validation, or the store's ownership,
  limits or ETags, and never read `extensions.forms.config` or
  `extensions.store.config`: it uses `FormsExports` and `StoreExports`
  (contract version 1) through `ctx.get`. A capability it needs from either
  package is a new, versioned, tested export there first.
- Apache-2.0. Do not publish packages by hand. This package is released with
  core at core's version and installed with `urlcode extensions add form-records`;
  `"private": true` in `package.json` only prevents an accidental
  `npm publish`. `src/extension.ts` is its definition (scaffold, example and
  host); `urlcode.json` is generated from it (`npm run build:addons`).
- TypeScript run through Node type stripping; `dist/` is built, never
  committed. Workspace siblings resolve through the `file:../<name>` links
  that `scripts/check-workspace-links.ts` enforces, never from a registry.
- Run `npm run verify` for every change. Ownership (cross-user 404),
  non-editable fields, stale versions (412) and CSRF each need a regression
  test in the same PR.
- Never commit credentials or customer data. Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI is not a security
  review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. File it against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates -- this package lives in that same repository.
