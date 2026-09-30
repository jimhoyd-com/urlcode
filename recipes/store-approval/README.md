# Store approval

`/api/requests/*` is an approval workflow for signed-in users. The project
declares an owned `requests` collection and a `reviewers` membership list; the
operator-installed `store` extension serves them. It is YAML only, with no
handler code:

- **Drafting.** A request opens as a `draft`. `status`, `reviewedBy` and
  `reviewedAt` are in `readOnlyProperties`, so a body that names one is `422`.
  Nobody approves a request by writing its status.
- **Submitting.** The owner runs `submit` (`POST /api/requests/<id>/submit`)
  to move it to `pending`, and `withdraw` to take it back to `draft`.
- **Reviewing.** `approve` and `reject` are `by: others` transitions with
  `members: reviewers`, served on their own mounts (`POST /api/approve/<id>`,
  `POST /api/reject/<id>`). Only a reviewer may run them, and never on their
  own request: a non-member gets `403 membership_required`, a reviewer's own
  request `403 own_record_refused`. Each stamps `reviewedBy` with the
  reviewer's principal id and `reviewedAt` with the commit time.
- **Locking.** `editable: {status: draft}` and
  `deletable: {status: [draft, rejected]}` keep a decision as it was made. Once
  a request is submitted, `PUT` and `PATCH` answer `409 record_locked`, so the
  owner cannot change the amount a reviewer approved. An approved request
  cannot be deleted. A record's `Allow` header says which methods it takes now
  (`GET, HEAD` once approved), so a client can hide Edit and Delete.
- **The queue.** A reviewers-only readers mount lists every owner's requests,
  read-only: `GET /api/review?status=pending` is the queue. With
  `showOwner: true` each record carries `_owner`, the requester's principal id.
  Everyone else gets `403`, and owners keep their own view on
  `/api/requests`.

Full contract: [membership gates][docs/STORE.md#membership-gates-and-cross-owner-reads]
and [edit and delete states][docs/STORE.md#edit-and-delete-states].

## Operator prerequisites

The store and a principal are not core and do not activate on their own. In a
site, `urlcode extensions add auth store` installs both and registers them in
`host.mjs`, outside the project. The database file stays outside the project,
and one server process serves it.

Who may review is data, not YAML. `urlcode test` and `audit` run on fresh,
throwaway databases and seed them from `tests/seed.json`: the accounts the
fixtures sign in as (`alice`, `bob`, `rita`) under `auth.users`, and the
reviewer, `rita`, under `store.members`. A served site adds each reviewer's
user id (`npx urlcode-auth find-user --email <email>` prints it):

```sh
npx urlcode-store members add --database /operator/data/store.sqlite --project /absolute/site/app \
  --collection reviewers --principal <user id>
```

**The fixtures sign in through the real auth extension**, and cover its mount
with an asserted sign-in and `GET /api/auth/get-session`, as in the
[store-booking recipe](../store-booking/README.md#operator-prerequisites),
which also shows the host. `routes/auth.yaml` is the auth mount
`urlcode extensions add auth` writes: in a site created with
`extensions add auth store`, `urlcode recipes add store-approval --project app`
merges the recipe into `app/` and moves `expectRoutes` in
`app/tests/audit.json` to 5.

## The local loop

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --local-review
urlcode test --project . --host-file /operator/host.mjs --local-review
urlcode audit --project . --expect-routes 5 --host-file /operator/host.mjs --local-review
```

`--local-review` pins the host to the project's current revision for that one
run, on `http://localhost`, and reads no operator policy, so every edit is
checked without a new pin ([the local review loop][docs/EXTENSIONS.md#the-local-review-loop]).
Serving is not: `urlcode serve` and `urlcode dev` need the revision you
reviewed and the public `--origin`.

Every `test` and `audit` run starts from empty, seeded databases, so the
fixtures leave the approved request behind without affecting the next run.

## Before exposing it

Keep `auth: true` on all four store routes: the transition and readers mounts check
their members only once a principal is present. Send `If-Match` with the
`ETag` a reviewer read on `approve`, so nobody approves a version they did
not see. `showOwner` shows an opaque id; to show a name, keep it in a property
the owner writes. Cloudflare, AWS, Vercel and static targets refuse the store,
so run it on the self-hosted runtime with a persistent disk.

<!-- x-release-please-start-version -->
[docs/STORE.md#membership-gates-and-cross-owner-reads]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#membership-gates-and-cross-owner-reads
[docs/STORE.md#edit-and-delete-states]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/STORE.md#edit-and-delete-states
[docs/EXTENSIONS.md#the-local-review-loop]: https://github.com/jimhoyd-com/urlcode/blob/v0.6.5/docs/EXTENSIONS.md#the-local-review-loop
<!-- x-release-please-end -->
