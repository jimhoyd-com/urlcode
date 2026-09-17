# Asset demonstration

This is a runnable example, not a separate starter choice. From the runtime checkout:

```sh
make dev PROJECT=examples/assets
# In another terminal:
make test-project PROJECT=examples/assets
```

Try `/hello/Ada` for a function, `/go` for a redirect, `/about` for HTML,
`/assets/example.txt` for a static file, and `/download` for an attachment.
Assets live in `public/`; never put secrets there. See the
[asset guide](../../docs/ASSETS.md) for MIME, caching and resource limits.

To start your own small app, use `urlcode init ../my-links`. It creates one
function route and one regular redirect. Add asset routes when you need them.
URLCode is licensed under the Apache License 2.0.
