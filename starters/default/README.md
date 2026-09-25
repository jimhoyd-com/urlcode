# Your URLCode site

This is a bare, agent-ready URLCode site. It starts with no routes so your
application's YAML and tests describe only the behavior you intend to ship.

- `app/` is the route project: `urlcode.yaml`, functions, `tests/requests.json`.
- `host.mjs` is the trusted operator host. It lists the installed extensions
  and stays outside `app/`.
- `package.json` pins the URLCode runtime, and every add-on, exactly;
  `package-lock.json` records their integrity.

```sh
npm install
npm run dev
# In another terminal:
npm test
```

`npm test` has no cases until you add `app/tests/requests.json`. `npm run
audit` intentionally reports `no-active-routes` until you add the first route.
The included GitHub workflow permits only that initial audit result; remove
`allow-empty-project: true` after adding a route.

Add, remove and upgrade extensions and artifacts released with this runtime
from the site directory:

```sh
npx urlcode extensions available
npx urlcode extensions add ui auth --example   # --example adds working demos, such as a signed-in /private page
npx urlcode extensions remove auth
npx urlcode upgrade --check
```

`extensions add` installs only the capability (for example auth's `/account/*`
pages, with no page of yours protected yet); `--example` also writes each added
extension's demo, such as store's `/api/todos` collection and `/todos` screen or
forms' `/contact` flow.

Start with the local MCP `get_context` tool (or `npx urlcode context --project
app`), then add the smallest declarative route or custom code the task requires.
`AGENTS.md` explains the workflow and points to the optional hosted shared
tooling at https://urlcode.ai/llms.txt.

Keep this site in your own Git repository. Secrets stay in ignored `.env.local`,
`data/` or provider environment values, with external operator policy for
function grants. See
[security](https://github.com/jimhoyd-com/urlcode/blob/main/docs/FUNCTION-SECURITY.md)
and [readiness](https://github.com/jimhoyd-com/urlcode/blob/main/docs/READINESS.md).
URLCode is licensed under the Apache License 2.0.
