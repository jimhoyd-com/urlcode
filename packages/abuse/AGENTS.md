# Working on URLCode abuse

- Read the root [CONTRIBUTING.md](../../CONTRIBUTING.md) and [SECURITY.md](../../SECURITY.md) first. Core owns the
  generic extension contract (`@jimhoyd/urlcode/extensions`). This package owns the persistent abuse counters, the
  budget and backoff bounds, the counter key derivation, and the challenge wrapper. It never reimplements core's
  `policies.throttle`, client-address parsing (`clientKey`) or request helpers. It knows nothing about auth, forms
  or any other consumer.
- `AbuseExports` v1 (`src/types.ts`) is a contract other packages build against. Change it only additively. A
  breaking change is v2.
- Apache-2.0. Do not publish packages by hand. This package is released with core at core's version and installed
  with `urlcode extensions add abuse`. `"private": true` in `package.json` only prevents an accidental
  `npm publish`. `src/extension.ts` is its definition (scaffold and host). `urlcode.json` is generated from it
  (`npm run build:addons`).
- TypeScript runs through Node type stripping. `dist/` is built, never committed.
- Run `npm run verify` for every change, and add a regression test under `test/` for behavior this package owns.
  Keep these tests passing:
  - `store.test.ts`: the counters.
  - `challenge.test.ts`: the wrapper.
  - `turnstile.test.ts`: the provider.
  - `extension.test.ts`: the definition, with a synthetic consumer.
- Never commit credentials or customer data. Use synthetic fixtures only.
- Report actual evidence and remaining limitations. CI is not a security review.

## File what you find

Do not drop a defect, a gap or an idea you could not act on. File it against
[urlcode](https://github.com/jimhoyd-com/urlcode/issues), using its issue templates. This package lives in that same
repository.
