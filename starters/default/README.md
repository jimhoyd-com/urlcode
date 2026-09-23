# Your URLCode project

This is a bare, agent-ready URLCode scaffold. It starts with no routes so your
application's YAML and tests describe only the behavior you intend to ship. Its
single fixture proves the empty project returns 404.

```sh
urlcode dev
# In another terminal:
urlcode test
```

`urlcode audit --expect-routes 0` intentionally reports `no-active-routes` until
you add the first route. The included GitHub workflow permits only that initial
audit result; remove `allow-empty-project: true` after adding a route.

Start with the local MCP `get_context` tool (or `urlcode context --project .`),
then add the smallest declarative route or custom code the task requires. Keep
`tests/requests.json` aligned with every route you add and update the audit
count deliberately. `AGENTS.md` explains the workflow and points to the
optional hosted shared tooling at https://urlcode.ai/llms.txt.

This app uses the runtime you installed separately (compatible with 0.1.0).
Without a global install, invoke `node /path/to/urlcode/packages/core/src/cli.ts` instead of
`urlcode`. Optional Make shortcuts accept `URLCODE='node /path/to/urlcode/packages/core/src/cli.ts'`.
For a cloneable project with a pinned npm runtime dependency, use
[urlcode-template](https://github.com/jimhoyd-com/urlcode-template). Both start
with the same bare scaffold. No runtime fork or provider account is needed.

Keep this app in your own Git repository. Secrets stay in ignored `.env.local`
or provider environment values, with external operator policy for function grants.
See [security](https://github.com/jimhoyd-com/urlcode/blob/main/docs/FUNCTION-SECURITY.md)
and [readiness](https://github.com/jimhoyd-com/urlcode/blob/main/docs/READINESS.md).
Add routes and assertions as your app grows; update the expected count deliberately.
URLCode is licensed under the Apache License 2.0. `gitignore.template` is initializer packaging
source and can be removed after `.gitignore` exists.
