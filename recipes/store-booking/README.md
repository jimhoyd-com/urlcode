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

Who may book is data, not YAML. `urlcode test` and `audit` run on fresh,
throwaway databases and seed them from `tests/seed.json`: the accounts the
fixtures sign in as (`alice` and `bob`, who are staff, and `carol`, who is
not) under `auth.users`, and the staff under `store.members`. A served site
adds each member's user id (`npx urlcode-auth find-user --email <email>`
prints it):

```sh
npx urlcode-store members add --database /operator/data/store.sqlite --project /absolute/site/app \
  --collection staff --principal <user id>
```

**The fixtures sign in through the real auth extension.** Each caller's
requests are a `steps` fixture that first posts to `/api/auth/sign-in/email`
and asserts the signed-in user's id; the fixture's cookie jar keeps the
session, and the next sign-in switches the caller. The auth mount is a route
like any other, so the audit needs it covered: the asserted sign-ins cover its
`POST` and an asserted `GET /api/auth/get-session` its `GET`
([authenticated routes][docs/READINESS.md#authenticated-routes-auth-true]).
Better Auth allows 10 sign-ins a minute per client, so the fixtures change
caller only where the story needs it.

The auth extension serves exactly one mount, so the recipe carries it:
`routes/auth.yaml`, included from `urlcode.yaml`, is the file
`urlcode extensions add auth` writes. In a site created with
`urlcode init <site>` and `urlcode extensions add auth store`, run
`urlcode recipes add store-booking --project app` in the site: it merges the
collections, the route, the fixtures and the seed into `app/` (the site's
`routes/auth.yaml` is the same file) and moves `expectRoutes` in
`app/tests/audit.json` to 2. The site's own `host.mjs` is
the host:

```js
// host.mjs -- trusted operator code, outside app/
import { composeHost } from '@jimhoyd/urlcode/host';
import auth from '@jimhoyd/urlcode-auth/extension';
import store from '@jimhoyd/urlcode-store/extension';

export default await composeHost(import.meta.url, [auth(), store({ database: '/operator/data/store.sqlite' })]);
```

The store-credits and store-approval recipes work the same way.

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
reviewed, as the `projectSha256` of the `--policy` file or `PROJECT_SHA256`,
and the public `--origin`.

The fixtures book, cancel and rebook one Monday in 2030. Every `test` and
`audit` run starts from empty, seeded databases, never the site's own, so
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
