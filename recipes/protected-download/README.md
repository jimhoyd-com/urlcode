# Protected download

`/downloads/report` serves `files/report.txt` as an attachment, but only after
the operator-installed `auth` extension authorizes the request (`auth: true`,
the short form of `policies.extensions.auth`). The file is
served natively: no project code runs at all, and the response is forced to `no-store`.

Like the `authenticated-json-api` recipe, this project declares the extension
and needs an operator host file outside the project, the canonical origin and
the project revision the operator reviewed for every command:

```sh
urlcode extensions --project .     # review the project, then note "Project revision: <sha256>"
export PROJECT_SHA256=<the reviewed revision>
urlcode validate --local --project . --host-file /operator/host.mjs --origin https://files.example.com
urlcode test --project . --host-file /operator/host.mjs --origin https://files.example.com
urlcode audit --project . --expect-routes 1 --host-file /operator/host.mjs --origin https://files.example.com
```

Use the host file from the
[`authenticated-json-api` README](../authenticated-json-api/README.md#the-host-file);
its configuration schema already accepts `realm: downloads`, and the bundled
fixtures expect the demo token `demo-token`. That host takes the reviewed
revision from `PROJECT_SHA256` or a `--policy` file and never recomputes it, so
replacing the attachment or editing `urlcode.yaml` makes every command refuse
with a revision pin mismatch until you review the change and supply the new
revision ([the review gate](../authenticated-json-api/README.md#the-review-gate)).
A real deployment registers `urlcode-auth` instead. Replace `files/report.txt`
with the real attachment and adjust `filename` and `contentType`. Cloudflare
refuses extensions.
