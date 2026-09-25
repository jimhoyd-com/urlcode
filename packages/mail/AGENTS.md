# Working on URLCode mail

- Read the root [CONTRIBUTING.md](../../CONTRIBUTING.md) and
  [SECURITY.md](../../SECURITY.md) first. Core owns the generic extension
  contract (`@jimhoyd/urlcode/extensions`); this package owns the mail contract (`MailExports` v1,
  `contributes.mail` templates and their slot kinds), copy files, the send
  pipeline (deadline, concurrency, refusal order) and the transports. It
  serves no routes and logs nothing. It never learns what a message means:
  account policy, enumeration defenses and rate limits stay with the
  consumer (auth, forms).
- Apache-2.0. Do not publish packages by hand. This package is released with
  core at core's version and installed with `urlcode extensions add mail`;
  `"private": true` in `package.json` only prevents an accidental
  `npm publish`. `src/extension.ts` is its definition (scaffold and host);
  `urlcode.json` is generated from it (`npm run build:addons`).
- TypeScript run through Node type stripping; `dist/` is built, never
  committed. Any workspace sibling peer resolves through the `file:../<name>`
  link that `scripts/check-workspace-links.ts` enforces, never from a
  registry.
- Run `npm run verify` for every change. Add a regression test beside the
  behavior: `test/templates.test.ts` (contributions, copy, slot kinds),
  `test/send.test.ts` (pipeline), `test/transports.test.ts` and
  `test/extension.test.ts` (definition, activation, the fake consumer in
  `test/fixtures/notifier.ts`).
- Keep the invariants in [SECURITY.md](SECURITY.md): no slot in a subject,
  `page-link` refuses a query, no address or value in a `MailError` message,
  development transports refused off node.
- Never commit credentials or customer data. Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI is not a security
  review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. File it against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates -- this package lives in that same repository.
