# Working on URLCode audit

- Read the root [CONTRIBUTING.md](../../CONTRIBUTING.md) and
  [SECURITY.md](../../SECURITY.md) first. Core owns the generic extension
  contract (`@jimhoyd/urlcode/extensions`); this package owns the audit log:
  the event contract (`validateAuditEvent`), the drain loop over producer
  outboxes, the SQLite store, retention and the `urlcode-audit` CLI. It never
  owns what is audited (producers decide) or who may read it (readers check
  `audit.read`/`audit.export`), and core never names it.
- [SECURITY.md](SECURITY.md) states the delivery guarantee. A change that
  weakens any of its five points (atomic capture, stored once, fail closed,
  bounded lag, record before release) is a contract change: update SECURITY.md,
  the README and the tests in the same change, and never skip or ack an event
  that was not stored.
- `src/event.ts` is pure (no I/O): auth's store worker imports it at runtime.
  Keep it that way.
- Apache-2.0. Do not publish packages by hand. This package is released with
  core at core's version and installed with `urlcode extensions add audit`;
  `"private": true` in `package.json` only prevents an accidental
  `npm publish`. `src/extension.ts` is its definition (scaffold and host);
  `urlcode.json` is generated from it (`npm run build:addons`).
- TypeScript run through Node type stripping; `dist/` is built, never
  committed. It has no sibling peers, only `@jimhoyd/urlcode`.
- Run `npm run verify` for every change. `test/drain.test.ts` exercises the
  producer contract with a fake in-memory outbox; auth and store prove it with
  their real outboxes in their own tests.
- Never commit credentials or customer data. Synthetic fixtures only.
- Report actual evidence and remaining limitations; CI is not a security
  review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. File it against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue
templates -- this package lives in that same repository.
