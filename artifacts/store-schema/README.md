# Store schema artifact

An inert URLCode artifact: the `store` extension's configuration schema
(`schemas/config.json`) and a minimal example configuration
(`config/example.json`). Tooling and agents read it; nothing imports or runs it.
Its `urlcode.json` lists both as standard documents, so
`urlcode artifacts inspect store-schema` reports their media type, digest and
size offline.

`schemas/config.json` is generated from the store extension's own definition by
`npm run build:addons`, so it always matches the store released beside it.
Installing it (`urlcode artifacts add store-schema`) does not install or
activate the store extension; for that, run `urlcode extensions add store`.
