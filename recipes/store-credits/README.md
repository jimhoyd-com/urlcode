# Store credits

`/api/wallets/*` holds credit wallets for signed-in users, and
`/api/directory/*` finds one by its handle. The project declares an owned
`wallets` collection with two transfers, a directory and an `issuers`
membership list; the operator-installed `store` extension serves them. There
is no handler code, and the sum over all wallets never changes:

- **Opening.** A wallet opens at `0` under a handle. `balance` defaults to `0`
  and is in `readOnlyProperties`, so a body that names it is `422`. Nobody
  mints by writing a balance.
- **A unique handle.** `unique: [handle]` keeps each handle on one wallet,
  whoever owns it: opening or renaming a wallet to a handle another wallet
  holds is `409 value_taken`, which never says whose. The handle's `pattern`
  allows lower case only, so `Bob` cannot pose as `bob`.
- **The directory.** A readers mount with `properties: [handle]` shows every
  signed-in user each wallet's `id` and `handle`, and nothing else: no
  balance, owner or timestamp. `GET /api/directory?handle=bob` answers the one
  wallet holding that handle, and the payer pays its `id`. Because the handle
  is unique, the lookup cannot be spoofed by another user naming a wallet
  `bob`. Handles are first come, first served, so a payer still learns the
  recipient's handle from the recipient.
- **The issuer.** Credits come in through `issue`, a transfer with a negative
  `min` and `members: issuers`. Only a member of `issuers` may run it, and
  only from their own wallet, which may go down to `-1000000`. That wallet's
  negative balance is the credit outstanding; a non-member gets
  `403 membership_required`.
- **Paying.** `pay` moves whole credits from the caller's own wallet to anyone's
  and never below `0`: an overdraft is `409 insufficient_balance`, a fraction
  `422`, and debiting someone else's wallet the `404` of a missing one.
- **Closing.** A wallet still holding credits cannot be deleted
  (`409 balance_not_zero`). Pay it back to `0` first.

Full contract: [declared transfers][docs/STORE.md#declared-transfers] and
[a directory by a unique handle][docs/STORE.md#a-directory-by-a-unique-handle].

## Operator prerequisites

The store and a principal are not core and do not activate on their own. In a
site, `urlcode extensions add auth store` installs both and registers them in
`host.mjs`, outside the project. The database file stays outside the project,
and one server process serves it.

Who may issue is data, not YAML. `urlcode test` and `audit` run on a throwaway
database and seed the issuer the fixtures sign in as, `treasurer`, from
`tests/seed.json`. A served site adds the issuer's principal id before issuing:

```sh
npx urlcode-store members add --database /operator/data/store.sqlite --project /absolute/site/app \
  --collection issuers --principal treasurer
```

**The fixtures need a stand-in principal.** They name their callers with
`Authorization: Bearer <id>` (`treasurer`, `alice`, `bob`), which only the
stand-in principal in the
[store-booking recipe](../store-booking/README.md#operator-prerequisites)
accepts. It is a protocol example, not authentication, and the real auth
extension does not accept it. In a site created with `extensions add auth`,
each caller signs in instead: write the caller's requests as a `steps` fixture
that first posts to `/api/auth/sign-in/email`, and add the accounts to
`tests/seed.json` under `auth.users`, with the ids `store.members` names
([authenticated routes][docs/READINESS.md#authenticated-routes-auth-true]).
The issuer is then added by their Better Auth user id.

## The local loop

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --local-review
urlcode test --project . --host-file /operator/host.mjs --local-review
urlcode audit --project . --expect-routes 2 --host-file /operator/host.mjs --local-review
```

`--local-review` pins the host to the project's current revision for that one
run, on `http://localhost`, and reads no operator policy, so every edit is
checked without a new pin ([the local review loop][docs/EXTENSIONS.md#the-local-review-loop]).
Serving is not: `urlcode serve` and `urlcode dev` need the revision you
reviewed and the public `--origin`.

The fixtures open three wallets, refuse a taken handle, issue 100 credits,
look the recipient up in the directory and pay it, refuse an overdraft and a
deletion, and pay everything back to the issuer. Every `test` and `audit` run
starts from an empty, seeded database, never the site's own, so they run again
unchanged.

## Before exposing it

Keep `auth: true` on both mounts and `idempotency` on the collection, so a
client retries a transfer with an `Idempotency-Key` and nothing moves twice.
The directory shows every handle, and `value_taken` tells anyone that a handle
is in use: keep handles public names, never an email, and put a throttle
policy on `/api/wallets/*` to bound probing. The issuer
floor bounds the credit outstanding; raise it deliberately. Cloudflare, AWS,
Vercel and static targets refuse the store, so run it on the self-hosted
runtime with a persistent disk.

<!-- urlcode-current-version:start -->
[docs/STORE.md#declared-transfers]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#declared-transfers
[docs/STORE.md#a-directory-by-a-unique-handle]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#a-directory-by-a-unique-handle
[docs/READINESS.md#authenticated-routes-auth-true]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md#authenticated-routes-auth-true
[docs/EXTENSIONS.md#the-local-review-loop]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-local-review-loop
<!-- urlcode-current-version:end -->
