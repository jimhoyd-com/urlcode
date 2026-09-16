# Starter projects

Status: planned. No runnable starter or CLI exists yet. The [roadmap](../ROADMAP.md)
owns delivery order. Starter publication accompanies working runtime features;
do not advertise clone/install commands until a fresh checkout passes the guide.

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
Publish tested, versioned app-only starter snapshots in a public cloneable starter
repository, with selectable starter directories and clear instructions for making
an owned application repository. Do not make users extract runtime internals.
The exact publication repository name is not reserved yet.

The proposed `urlcode init --template <name>` command should copy the same tested
starter files directly into a new app directory. Plain Git clone must remain an
option; the CLI path cannot require an account or Cloud. Both paths produce the
same ordinary, editable project. Reject overwriting existing work by default.
Published starters contain only public app material, never private planning history.

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
