# Store booking

`/api/bookings/*` books rooms by the hour for signed-in users. The project
declares one owned `bookings` collection; the operator-installed `store`
extension serves it. There is no handler code:

- `intervals` refuses a booking that overlaps a booked booking of the same
  room, whoever owns it, with `409 interval_conflict`. An adjacent booking
  and another room are accepted.
- The `cancel` transition (`POST /api/bookings/<id>/cancel`) moves `booked` to
  `cancelled`. `intervals` counts only `status: booked`, so cancelling frees
  the slot for anyone.
- `status` is in `readOnlyProperties`: a body naming it is `422`, so only the
  transition changes it.
- The `start` and `end` patterns keep bookings to whole UTC hours. Change the
  pattern for other slot lengths; the store compares the instants.

Full contract: [non-overlapping intervals][docs/STORE.md#non-overlapping-intervals].

## Operator prerequisites

The store and a principal are not core and do not activate on their own. In a
site, `urlcode extensions add auth store` installs both and registers them in
`host.mjs`, outside the project. The database file stays outside the project,
and one server process serves it.

The bundled fixtures name their callers with `Authorization: Bearer <id>`
(`alice`, `bob`), which the stand-in principal below accepts. It is a protocol
example, not authentication. With the real auth extension, callers sign in
through Better Auth: write each caller's requests as a `steps` fixture that
signs in first ([readiness][docs/READINESS.md]).

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

The fixtures book, cancel and rebook one Monday in 2030, then delete every
booking they made, so they run again on the same database. Point them at a
scratch database, not one holding real bookings.

## Before exposing it

Keep `auth: true` on the mount: an owned collection needs a principal. To let
only some users book, declare a `membership` collection and gate a transition
with `members`; creates cannot be limited to a membership list yet. Cloudflare,
AWS, Vercel and static targets refuse the store, so run it on the self-hosted
runtime with a persistent disk.

<!-- urlcode-current-version:start -->
[docs/STORE.md#non-overlapping-intervals]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#non-overlapping-intervals
[docs/READINESS.md]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/READINESS.md
[docs/EXTENSIONS.md#the-local-review-loop]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-local-review-loop
<!-- urlcode-current-version:end -->
