# Protected download

`/downloads/report` serves `files/report.txt` as an attachment, but only after
the operator-installed `auth` extension authorizes the request (`auth: true`,
the short form of `policies.extensions.auth`). The file is
served natively: no guest code runs, and the response is forced to `no-store`.

Like the `authenticated-json-api` recipe, this project declares the extension
and needs an operator host file outside the project plus the canonical origin
for every command:

```sh
urlcode validate --local --project . --host-file /operator/host.mjs --origin https://files.example.com
urlcode test --project . --host-file /operator/host.mjs --origin https://files.example.com
urlcode audit --project . --expect-routes 1 --host-file /operator/host.mjs --origin https://files.example.com
```

Use the host file from the `authenticated-json-api` README with the config
schema accepting `realm: downloads`; the bundled fixtures expect the demo token
`demo-token`. A real deployment registers `urlcode-auth` instead. Replace
`files/report.txt` with the real attachment and adjust `filename` and
`contentType`. Cloudflare refuses extensions.
