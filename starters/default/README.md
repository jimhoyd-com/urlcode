# Your URLCode project

This is a bare, agent-ready URLCode scaffold. It starts with no routes so your
application's YAML and tests describe only the behavior you intend to ship. It
does not create routes, functions, middleware, or request fixtures for you.

```sh
urlcode dev
# In another terminal:
urlcode test
```

`urlcode test` has no cases until you add `tests/requests.json`. `urlcode audit
--expect-routes 0` intentionally reports `no-active-routes` until you add the
first route. The included GitHub workflow permits only that initial audit
result; remove `allow-empty-project: true` after adding a route.

Start with the local MCP `get_context` tool (or `urlcode context --project .`),
then add the smallest declarative route or custom code the task requires. Add
`tests/requests.json` with the first route, keep it aligned with every route,
and update the audit count deliberately. `AGENTS.md` explains the workflow and
points to the optional hosted shared tooling at https://urlcode.ai/llms.txt.

The commands above assume `urlcode` on PATH (a global install). When this
project's `package.json` pins `@jimhoyd/urlcode` instead, use the npm scripts
(`npm run dev`, `npm test`, `npm run validate`, `npm run audit`) or
`npx --no --package @jimhoyd/urlcode urlcode …`; `--no` runs the installed copy
and never fetches. The Make shortcuts pick `node_modules/.bin/urlcode` when it
exists and accept an override such as `URLCODE='node /path/to/urlcode/dist/cli.js'`.
The `$schema` line in `urlcode.yaml` and the workflow's action tag name the
runtime release that generated this project; move them when you upgrade.
For a cloneable project with a pinned npm runtime dependency, use
[urlcode-template](https://github.com/jimhoyd-com/urlcode-template). Both start
with the same bare scaffold. No runtime fork or provider account is needed.

Keep this app in your own Git repository. Secrets stay in ignored `.env.local`
or provider environment values, with external operator policy for function grants.
See [security](https://github.com/jimhoyd-com/urlcode/blob/main/docs/FUNCTION-SECURITY.md)
and [readiness](https://github.com/jimhoyd-com/urlcode/blob/main/docs/READINESS.md).
Add routes and assertions as your app grows; update the expected count deliberately.
URLCode is licensed under the Apache License 2.0.
