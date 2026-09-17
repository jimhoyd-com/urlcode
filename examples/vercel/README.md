# URLCode on Vercel

A native-handler project deployed as a Vercel Node function. See
[the adapter guide](../../docs/VERCEL.md) for what is and is not supported.

```sh
urlcode test --project .     # the same assertions run locally
vercel deploy
```

`vercel.json` rewrites every path to `api/index.js`, which serves the project
with `createVercelHandler`. `includeFiles` must list every file the project
reads; add to it when you add a page, download or static directory.
