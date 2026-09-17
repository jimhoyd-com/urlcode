# URLCode on Cloudflare Workers

A declarative project compiled to a Worker. See
[the target guide](../../docs/CLOUDFLARE.md) for what is and is not supported.

```sh
urlcode test --project .   # the same assertions run against the local runtime
npm run build              # writes dist/{index,artifact,validators}.js
npx wrangler deploy
```

The build is the deploy unit: `dist/` is generated, never edited, and never
committed. Rebuild after every change to `urlcode.yaml` — the Worker reads the
artifact, not the YAML.

`wrangler.toml` sets no `nodejs_compat` flag on purpose. The runtime and the
precompiled schema validators use Web standards only, so nothing here needs a
Node compatibility layer.
