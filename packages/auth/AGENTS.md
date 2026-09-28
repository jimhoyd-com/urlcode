# Working on URLCode auth

- Read the root [CONTRIBUTING.md](../../CONTRIBUTING.md) and [SECURITY.md](../../SECURITY.md) first. Accounts and
  sessions are Better Auth's; this package only serves one Better Auth instance on one mount, gates routes with a
  verified session, and hands the user id to route code as the `identity` capability. Do not rebuild account,
  session, password or permission machinery here: add a Better Auth plugin or keep it in the application.
- `src/auth.ts` is the adapter, `src/extension.ts` the definition (scaffold and host), `src/cli.ts` the operator CLI.
  `urlcode.json` is generated from the definition (`npm run build:addons`).
- TypeScript runs through Node type stripping. `dist/` is built, never committed. Run `npm run verify` for every
  change and keep `test/auth.test.ts` passing; the end-to-end application proof is
  `test/private-requests.integration.ts` at the repository root (`npm run test:proof`).
- Never commit credentials or customer data. Use synthetic fixtures only.

## File what you find

File defects and ideas against [urlcode](https://github.com/jimhoyd-com/urlcode/issues).
