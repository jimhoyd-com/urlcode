# Your URLCode project

This is an application, independent of URLCode's source. Requires URLCode
0.1.0-alpha.4 and Node.js 22.13+ (22/24 are the CI targets). No account or DB.
From this directory, with URLCode installed from its source checkout:

```sh
urlcode validate --local
urlcode dev
# In another terminal:
urlcode test
urlcode add https://example.com/new --alias new
```

Local server: http://127.0.0.1:3000. `dev` watches project files and reads
`.env.local`; `serve` uses injected environment values and does not watch.
Tests make local HTTP requests and never follow redirects to destinations.
Commit the project to your own repository. Do not commit secret values.
Use `urlcode serve` for a fixed process snapshot behind an HTTPS reverse proxy.
See the main URLCode operations guide for limits, deployment and rollback.
The runtime is an alpha; cloud provider adapters are not included yet.

Install URLCode using the [source quickstart](https://github.com/jimhoyd-com/urlcode#try-it).
`starter.json` records the compatible alpha runtime version. Pin the runtime
checkout to a reviewed commit of that version; upgrading it must not regenerate
this application. The license is undecided; no license terms have been selected.
`gitignore.template` is packaging source for the initializer and can be removed
from your app once `.gitignore` exists.

Native asset examples: `/about` serves HTML, `/assets/example.txt` serves a file,
and `/download` sends an attachment. Assets live in `public/`; never put secrets
in that directory. See the runtime asset guide for snapshot limits.

With Make installed, use `make dev`, `make validate`, and `make test` from this
app directory. Change the port with `make dev PORT=3001`. No global install is
required when using `make dev URLCODE='node /path/to/urlcode/src/cli.js'` (quote
a runtime path containing spaces inside that value). Make only wraps the CLI;
the `urlcode` commands above work without Make.
