# URLCode core source

`packages/core/src/` is the source directory for URLCode's core runtime. It is
deliberately **not** an npm workspace package and has no `package.json`.

The repository root is the published `@jimhoyd/urlcode` package: it combines
the built runtime in `dist/` with the schemas, starters, recipes, documentation
and AI authoring resources that ship together. `npm run build` compiles this
directory into that root `dist/` output; do not commit the generated files.

For a source checkout, run the CLI from the repository root, for example:

```sh
node packages/core/src/cli.ts validate --local --project starters/default
```

Optional extension packages live beside this directory under `packages/` and
depend on core's public contract. Core must not import their implementation;
`npm run check:code` enforces that one-way boundary.
