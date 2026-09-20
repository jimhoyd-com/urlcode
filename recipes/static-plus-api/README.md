# Static site with a JSON API

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 3`.

`/` serves `public/index.html`, `/assets/*` serves everything under
`public/assets` (with `index.html` for the directory itself), and `/api/info`
is a function returning JSON built from literal `args`. Pages and
assets are native: no project code runs for them at all, and they are snapshotted at
activation, so new files need a reload. Edit the HTML, add files under
`public/assets`, and change or extend `functions/info.mjs`.

The function needs the self-hosted runtime; drop `/api/info` to deploy the
static part on a serverless target. Static mounts cannot escape their
directory, and the recipe sets explicit caching so nothing is guessed.

Adding a function that writes files or accepts a POST body? Filesystem access
only exists in trusted (default) routes, since `sandbox: true` has no
filesystem, so keep the route trusted and state why with `sandboxReason`, as
`/api/info` does. `audit` advises when a POST route with a body policy has
neither `sandbox: true` nor `sandboxReason`.
