# Store credits

`/api/wallets/*` holds credit wallets for signed-in users. The project
declares an owned `wallets` collection with two transfers and an `issuers`
membership list; the operator-installed `store` extension serves them. There
is no handler code, and the sum over all wallets never changes:

- **Opening.** A wallet opens at `0`. `balance` defaults to `0` and is in
  `readOnlyProperties`, so a body that names it is `422`. Nobody mints by
  writing a balance.
- **The issuer.** Credits come in through `issue`, a transfer with a negative
  `min` and `members: issuers`. Only a member of `issuers` may run it, and
  only from their own wallet, which may go down to `-1000000`. That wallet's
  negative balance is the credit outstanding; a non-member gets
  `403 membership_required`.
- **Paying.** `pay` moves whole credits from the caller's own wallet to anyone's
  and never below `0`: an overdraft is `409 insufficient_balance`, a fraction
  `422`.
- **Closing.** A wallet still holding credits cannot be deleted
  (`409 balance_not_zero`). Pay it back to `0` first.

Full contract: [declared transfers][docs/STORE.md#declared-transfers].

## Operator prerequisites

The store and a principal are not core and do not activate on their own. In a
site, `urlcode extensions add auth store` installs both and registers them in
`host.mjs`, outside the project. The database file stays outside the project,
and one server process serves it.

Who may issue is data, not YAML. Add the issuer's principal id before issuing;
the fixtures sign in as `treasurer`:

```sh
npx urlcode-store members add --database /operator/data/store.sqlite --project /absolute/site/app \
  --collection issuers --principal treasurer
```

The bundled fixtures name their callers with `Authorization: Bearer <id>`
(`treasurer`, `alice`, `bob`), which the stand-in principal in the
[store-booking recipe](../store-booking/README.md#operator-prerequisites)
accepts. It is a protocol example, not authentication. With the real auth
extension, callers sign in through Better Auth, and the issuer is added by
their Better Auth user id.

## The local loop

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --local-review
urlcode test --project . --host-file /operator/host.mjs --local-review
urlcode audit --project . --expect-routes 1 --host-file /operator/host.mjs --local-review
```

`--local-review` pins the host to the project's current revision for that one
run, on `http://localhost`, and reads no operator policy, so every edit is
checked without a new pin ([the local review loop][docs/EXTENSIONS.md#the-local-review-loop]).
Serving is not: `urlcode serve` and `urlcode dev` need the revision you
reviewed and the public `--origin`.

The fixtures open three wallets, issue 100 credits, pay, refuse an overdraft
and a deletion, pay everything back to the issuer and delete every wallet, so
they run again on the same database. Point them at a scratch database.

## Before exposing it

Keep `auth: true` on the mount and `idempotency` on the collection, so a client
retries a transfer with an `Idempotency-Key` and nothing moves twice. The issuer
floor bounds the credit outstanding; raise it deliberately. Cloudflare, AWS,
Vercel and static targets refuse the store, so run it on the self-hosted
runtime with a persistent disk.

<!-- urlcode-current-version:start -->
[docs/STORE.md#declared-transfers]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#declared-transfers
[docs/EXTENSIONS.md#the-local-review-loop]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-local-review-loop
<!-- urlcode-current-version:end -->
