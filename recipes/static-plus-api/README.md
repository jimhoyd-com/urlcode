# Static site with a JSON API

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 3`.

`/` serves `public/index.html`, `/assets/*` serves everything under
`public/assets` (with `index.html` for the directory itself), and `/api/info`
answers literal JSON declared with `respond`. Every route is native: no project
code runs at all, and pages and assets are snapshotted at activation, so new
files need a reload. Edit the HTML, add files under `public/assets`, and change
the `respond.json` value in `urlcode.yaml`.

Static mounts cannot escape their directory, and the recipe sets explicit
caching so nothing is guessed. Because nothing here needs the Node lifecycle,
the AWS and Vercel targets activate the whole project.

Replace `respond` with a `function` only when the answer has to be computed per
request. That function runs trusted by default, with the filesystem, `fetch`
and npm packages available; a POST route with a body policy then gets an
`audit` advisory until it records the decision with `sandboxReason` (see
[AI authoring](../../docs/AI-AUTHORING.md)). A function needs the self-hosted
runtime.
