# Build-time TypeScript guest

`urlcode build-typescript` needs the optional TypeScript compiler. The runtime
does not, so install it only where you use this build, in the site whose
`@jimhoyd/urlcode` install runs the command (the directory holding its
`package.json`), so the runtime resolves it from the same `node_modules`:

```sh
npm install --save-dev --save-exact typescript@6.0.3
```

This is the exact command the runtime prints when the compiler is missing. A
project that never runs `build-typescript` does not need it.

Then run `urlcode build-typescript --project . --out ../hello-built` with a new
output directory, then `urlcode validate --local --project ../hello-built` and
`urlcode serve --project ../hello-built`. GET `/hello` returns JSON.
TypeScript is transpiled ahead of time. The runtime executes only the emitted
JavaScript, in QuickJS/WASM for a `sandbox: true` route and in-process for a
trusted one. The build does not type-check or read tsconfig.json. See
[TypeScript authoring](../../docs/TYPESCRIPT-AUTHORING.md).
