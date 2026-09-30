# Protected download

`/downloads/report` serves `files/report.txt` as an attachment, but only after
the operator-installed `auth` extension (Better Auth) authorizes the request
(`auth: true`, the short form of `policies.extensions.auth`). The file is
served natively: no project code runs at all, and the response is forced to
`no-store`.

Like the `authenticated-json-api` recipe, this project declares the extension
and carries the auth mount the extension serves, `routes/auth.yaml`, which is
the file `urlcode extensions add auth` writes. Use the host file from the
[`authenticated-json-api` README](../authenticated-json-api/README.md#the-host-file),
outside the project:

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --local-review
urlcode test --project . --host-file /operator/host.mjs --local-review
urlcode audit --project . --expect-routes 2 --host-file /operator/host.mjs --local-review
```

`test` and `audit` create the account the fixtures sign in as, `ada`, from
`tests/seed.json` in a throwaway database. The fixtures sign in through
`POST /api/auth/sign-in/email`, read the session and download the report; the
asserted sign-in and session read cover the auth mount for the audit. In a
site created with `urlcode extensions add auth`,
`urlcode recipes add protected-download --project app` merges the route,
`files/report.txt`, the fixtures and the seed into `app/` and moves
`expectRoutes` in `app/tests/audit.json` to 2.

Serving needs the revision the operator reviewed, which covers the attachment:
replacing it or editing `urlcode.yaml` makes a pinned command refuse with a
revision pin mismatch until you review the change and supply the new revision
([the review gate](../authenticated-json-api/README.md#serving-and-the-review-gate)).
Replace `files/report.txt` with the real attachment and adjust `filename` and
`contentType`. Cloudflare refuses extensions.
