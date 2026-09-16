# Live links without route reloads

Follow [the dynamic-link guide](../../docs/DYNAMIC-LINKS.md) to create an external
SQLite store and seed `demo -> https://example.com/demo`. Then start this project
with `--link-store links=/absolute/path/links.sqlite`. Its fixtures expect that
seed and an unused `not-created` code; use a disposable test store, not production.

Create/update/delete records through the CLI or separate authenticated API while
the public server keeps serving. YAML, code, route counts and health version do
not change per link. This example deliberately requires explicit operator storage
binding; the default starter still runs without a database.
