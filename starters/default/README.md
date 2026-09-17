# Your URLCode project

One starter: a URL that runs your function, and a regular redirect.
Created with `urlcode init ../my-links`. No template choice is needed.

```sh
urlcode dev
# In another terminal:
urlcode test
urlcode audit --expect-routes 2
urlcode benchmark --requests 1000 --concurrency 2
```

Visit http://127.0.0.1:3000/hello/Ada or http://127.0.0.1:3000/go.
`urlcode.yaml` loads `routes/functions.yaml` and `routes/marketing/links.yaml`.
Organize those files however you like; references are relative to the project root.
The function route uses `middleware/headers.mjs` to add a response header around
`await next()`. Edit or reuse it on other routes as needed.
GET/HEAD, redirect 302 and no-store defaults keep YAML short. Valid edits reload.

This app uses the runtime you installed separately (compatible with 0.1.0).
Without a global install, invoke `node /path/to/urlcode/src/cli.ts` instead of
`urlcode`. Optional Make shortcuts accept `URLCODE='node /path/to/urlcode/src/cli.ts'`.
For a cloneable project with a pinned npm runtime dependency, use
[urlcode-template](https://github.com/jimhoyd-com/urlcode-template). Both start
with the same two route examples. No runtime fork or provider account is needed.

Keep this app in your own Git repository. Secrets stay in ignored `.env.local`
or provider environment values, with external operator policy for function grants.
See [security](https://github.com/jimhoyd-com/urlcode/blob/main/docs/FUNCTION-SECURITY.md)
and [readiness](https://github.com/jimhoyd-com/urlcode/blob/main/docs/READINESS.md).
Add routes and assertions as your app grows; update the expected count deliberately.
URLCode is licensed under the Apache License 2.0. `gitignore.template` is initializer packaging
source and can be removed after `.gitignore` exists.
