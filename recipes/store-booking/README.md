# Store booking

`/api/bookings/*` books rooms one hour at a time for staff. The project
declares an owned `bookings` collection and a `staff` membership list; the
operator-installed `store` extension serves them. There is no handler code:

- **Staff only.** `create: {members: staff}` lets only a member of `staff`
  book: a signed-in non-member gets `403 membership_required` and nothing is
  written. Reading, changing and deleting stay each owner's own.
- **One-hour slots.** `length: PT1H` makes every booking exactly an hour
  and `step: PT1H` puts it on the hour, in UTC. A 12-hour booking or a 10:30
  start is `422 invalid_record`. Drop `length` to let a booking take several
  consecutive hours, use `PT30M` for half-hour slots, and add `origin`
  (`1970-01-01T00:00:00+05:30`) for a grid in a fixed local offset.
- **No overlap.** `intervals` refuses a booking that overlaps a booked booking of the same
  room, whoever owns it, with `409 interval_conflict`. An adjacent booking
  and another room are accepted.
- **Cancelling.** The `cancel` transition (`POST /api/bookings/<id>/cancel`) moves `booked` to
  `cancelled`. `intervals` counts only `status: booked`, so cancelling frees
  the slot for anyone.
- **The status.** `status` is in `readOnlyProperties`: a body naming it is `422`, so only the
  transition changes it.

Full contract: [non-overlapping intervals][docs/STORE.md#non-overlapping-intervals].

## Operator prerequisites

The store and a principal are not core and do not activate on their own. In a
site, `urlcode extensions add auth store` installs both and registers them in
`host.mjs`, outside the project. The database file stays outside the project,
and one server process serves it.

Who may book is data, not YAML. `urlcode test` and `audit` run on a fresh,
throwaway database and seed the staff the fixtures sign in as, `alice` and
`bob`, from `tests/seed.json`. A served site adds each member's principal id:

```sh
npx urlcode-store members add --database /operator/data/store.sqlite --project /absolute/site/app \
  --collection staff --principal <user id>
```

**The fixtures need this stand-in principal.** They name their callers with
`Authorization: Bearer <id>` (`alice`, `bob`, and `carol`, who is not staff),
which only the stand-in below accepts. It is a protocol example, not
authentication, and the real auth extension does not accept it. In a site
created with `extensions add auth`, each caller signs in instead: write the
caller's requests as a `steps` fixture that first posts to
`/api/auth/sign-in/email`, and add the accounts to `tests/seed.json` under
`auth.users`, with the ids `store.members` names
([authenticated routes][docs/READINESS.md#authenticated-routes-auth-true]).
The store-credits and store-approval recipes use the same stand-in.

```js
// /operator/host.mjs -- trusted operator code, never part of the project
import { composeHost } from '@jimhoyd/urlcode/host';
import store from '@jimhoyd/urlcode-store/extension';

const schema = { type: 'object', properties: {}, additionalProperties: false };
const standIn = { definition: { name: 'auth', contract: 1, targets: ['node'], schema, policySchema: schema, providesPrincipal: true,
  host({ projectSha256 }) {
    return { registration: { name: 'auth', version: '1', projectSha256, targets: ['node'], schema, policySchema: schema, providesPrincipal: true,
      activate() {
        return {
          handle() { return { status: 404, headers: [] }; },
          authorize(_requirement, request) {
            const match = /^Bearer ([a-z]{1,32})$/.exec(request.headers.get('authorization') ?? '');
            if (!match) return { status: 401, headers: [['content-type', 'text/plain']], body: 'sign in' };
            request.setPrincipal({ id: match[1] });
            return undefined;
          },
        };
      } } };
  } }, options: {} };

export default await composeHost(import.meta.url, [standIn, store({ database: '/operator/data/store.sqlite' })]);
```

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
reviewed, as the `projectSha256` of the `--policy` file or `PROJECT_SHA256`,
and the public `--origin`.

The fixtures book, cancel and rebook one Monday in 2030. Every `test` and
`audit` run starts from an empty, seeded database, never the site's own, so
they run again unchanged.

## Before exposing it

Keep `auth: true` on the mount: an owned collection needs a principal. To let
every signed-in user book, remove `create` and the `staff` collection.
Cloudflare, AWS, Vercel and static targets refuse the store, so run it on the
self-hosted runtime with a persistent disk.

<!-- urlcode-current-version:start -->
[docs/STORE.md#non-overlapping-intervals]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#non-overlapping-intervals
[docs/READINESS.md#authenticated-routes-auth-true]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md#authenticated-routes-auth-true
[docs/EXTENSIONS.md#the-local-review-loop]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-local-review-loop
<!-- urlcode-current-version:end -->
