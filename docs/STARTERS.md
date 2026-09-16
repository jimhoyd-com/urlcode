# Starter projects

Status: redirect and dynamic starters run with 0.1.0-alpha.1. The business
foundation remains planned. The [roadmap](../ROADMAP.md) owns delivery order.

Install URLCode from the [source quickstart](../README.md), then run:

```sh
urlcode init my-links --template redirects
urlcode init my-app --template dynamic
urlcode test --project my-app
```

For a manual copy, use `starters/redirects` or `starters/dynamic` from the public
checkout as your app directory. They run unchanged, with the same tests. The
CLI copies those files and ensures `.gitignore` is present even from an npm
archive. There is no registry package or separate starter repository. App-only branches
in the public repository provide the plain Git clone path:

```sh
git clone --single-branch --branch starter-dynamic https://github.com/jimhoyd-com/urlcode.git my-app
cd my-app
git remote rename origin starter-source
urlcode test
```

Use `starter-redirects` for the smaller starter. Install the runtime separately
first. Add your own Git remote when ready; the cloned app contains no runtime
source. These branches are generated from the tested `starters/` directories,
not independent implementations.

## Start small, grow the same project

Users install URLCode and clone a starter application into their own repository.
They own its YAML, functions, assets and tests. URLCode is a versioned dependency
or installed tool, upgraded separately; building a business does not require
forking or copying the runtime source. Fork the runtime only to change URLCode itself.

| Starter | First result | Included scope |
|---|---|---|
| Redirects | Try a few short URLs locally | Small YAML file, literal and parameterized redirects, request/response tests, README |
| Dynamic URLs | Run code when a URL is requested | Redirect foundation plus one custom function, validated inputs, local fake integration, tests and safe environment placeholders |
| Business foundation | Maintain and deploy an owned application | Same format organized into route/function/test folders, version pinning, CI, deployment/rollback guidance, health/logging and performance recipes as supported |

These are starting sizes, not separate editions. A redirect project can add a
function, split files and adopt business tooling in place, without migrating to
another product. Business use has no artificial route/traffic limits or required
Cloud account. No starter requires a database, frontend framework, authentication
service or paid integration merely to start. Apps add state and browser UI when
their own behavior needs them; URLCode remains a URL runtime.

## Distribution and ownership

Maintain starter sources under `starters/` in the public source repository.
App-only `starter-redirects` and `starter-dynamic` branches distribute the tested
source directories through Git. Record the exact cloned commit for reproducibility;
`starter.json` records runtime compatibility. No extraction of runtime internals.

The implemented `urlcode init <directory> --template <name>` command copies
the tested starter files directly into a new app directory. Plain Git clone must remain an
option; the CLI path cannot require an account or Cloud. Both paths produce the
same ordinary, editable project. Reject overwriting existing work by default.
Starter sources contain only public app material, never private planning history.

Pin the compatible URLCode version and any template/package dependencies using
the chosen packaging format. Record the starter version for troubleshooting.
Updating URLCode must not regenerate or overwrite user source. Future migration
tools should show changes for review. Do not silently track a moving runtime branch.

A project starter is an entire initial application. A behavior template is a
reusable route/function recipe within any application. Placecode and Peercode
are larger reference applications that can become cloneable examples when their
features work. Keep these distinct in documentation and commands.

## Common project contract

Every starter includes an accurate README, runnable local tests, a safe ignore
file and only the folders its example uses. Environment examples contain names
and placeholders; real local secrets live in ignored `.env.local`. Deployment
uses logical secret references bound to provider stores. No secrets in Git.

Git owns application definitions and code. Provider/environment settings are
separate from behavior. The same application runs locally and on capable
self-hosted adapters; future Cloud consumes the same project. Document unsupported
capabilities before deployment rather than substituting different behavior.
Application data and external services remain the application's responsibility.

Business guidance covers safe configuration changes, CI validation, bulk route
management, backups of app-owned state if any, upgrades, rollback, diagnostics
and measured load tests. Add provider recipes only when tested. Avoid scaffolding
empty services or a mandatory database for hypothetical future needs.

## Delivery and acceptance

- M1: redirect and dynamic starters alongside local functions and tests. Both
  clone and init paths work without a hosting account, database or ngrok.
- M2: show an existing starter growing into split route files, reusable behavior
  and bulk imports without replacing its project; include a 10k-route recipe.
- M3: business foundation with tested CI, self-host deployment, rollback and
  observability instructions. Add provider recipes through M4 as adapters pass.
- Placecode and Peercode become reproducible application examples with explicit
  dependencies, using the same public interfaces rather than private forks.

CI tests starter contents against the pinned runtime: install, validate, serve
and real HTTP assertions, including the custom function. Test both distribution
paths and safe failure on an existing destination. At release, have another
builder follow checkout-to-local instructions and record effort and failures;
then verify each claimed deployment recipe. Check upgrades preserve app source
and secrets are excluded. Publish measured results, not unsupported speed claims.

Free-product launch and stability still come before defining/building Cloud.
License selection remains deferred; this document does not select a license.
