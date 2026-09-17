# One starter, two examples

There is one starting project: a URL that runs a function and a regular redirect.
No `dynamic` versus `redirects` choice, and no `--template` option.

With URLCode installed:

```sh
urlcode init ../my-links
urlcode dev --project ../my-links
urlcode audit --project ../my-links --expect-routes 2
```

Or use the public GitHub template, which includes a pinned runtime dependency:

```sh
git clone https://github.com/jimhoyd-com/urlcode-template.git my-links
cd my-links
npm ci
npm run dev
npm run audit
```

GitHub's **Use this template** button creates your own repository directly.
These are two ways to obtain the same route examples, not two project types.
The CLI copies app files from `starters/default` and uses the installed runtime;
the public repository adds npm dependency/lockfile/CI for independent installation.
Neither path forks the runtime or needs a hosting account or database.

## Files and growth

`urlcode.yaml` includes a function route file and a redirect file in a nested
folder. A JavaScript function, HTTP assertions and optional Makefile are included.
See [organization](ORGANIZATION.md) for choosing your own layout. Defaults allow
GET/HEAD and use redirect 302; add configuration only when changing behavior.

Initialization refuses an existing destination. Own the app in your own repository,
keep secrets out of Git, and upgrade the runtime separately without regenerating
application files. Add pages, downloads, more functions and business-specific
features to this same project. Update tests and the expected route count as it grows.
See [readiness](READINESS.md) and [security](FUNCTION-SECURITY.md).

`examples/assets` contains a larger runnable file/page/download demonstration:
`make dev PROJECT=examples/assets`. It is an example, not a separate init choice.

The old `starter-dynamic` and `starter-redirects` branches are historical snapshots;
use `urlcode-template` for new clones. They are no longer maintained or advertised
as onboarding paths. Existing projects remain ordinary valid URLCode apps.

The runtime is licensed under Apache-2.0. Provider adapters follow the
[roadmap](../ROADMAP.md).
