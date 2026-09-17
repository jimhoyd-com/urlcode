# Build-time TypeScript guest

Run `urlcode build-typescript --project . --out ../hello-built` with a new output
directory, then `urlcode validate --local --project ../hello-built` and
`urlcode serve --project ../hello-built`. GET `/hello` returns JSON.
TypeScript is transpiled ahead of time. The runtime executes only the emitted
JavaScript in QuickJS/WASM. The build does not type-check or read tsconfig.json.
