---
"@jimhoyd/urlcode": minor
"@jimhoyd/urlcode-ui": minor
"@jimhoyd/urlcode-auth": minor
"@jimhoyd/urlcode-admin": minor
"@jimhoyd/urlcode-store": minor
"@jimhoyd/urlcode-forms": minor
"@jimhoyd/urlcode-mcp": minor
---

Extensions and artifacts are now add-ons with one shape: a `@jimhoyd/urlcode-<name>` package carrying a static `urlcode.json` descriptor, released as a tarball on core's GitHub Release at core's version and pinned by core's own `dist/addons.json` (URL and sha512). `urlcode init <dir>` always writes one site: `app/` (the route project), `host.mjs` (`composeHost` from `@jimhoyd/urlcode/host` over the installed extensions), and a `package.json` with an exact core pin and npm scripts. `urlcode extensions available|add|remove|list` and `urlcode artifacts available|add|remove|list` install each add-on and its `requires` once at the site's top level with `npm install --ignore-scripts`, check the lockfile against core's pin, and for an extension write its configuration, `app/routes/<name>.yaml`, operator files and `host.mjs` line, rolling everything back on failure. Each extension package default-exports a `defineExtension` definition from `./extension`. `validate` without `--host-file` checks declared extensions statically against their installed schemas, and the GitHub Action now takes a `site` and an optional `host-file`. The signed extension-bundle and artifact release channels, their catalogs, lockfiles and cache, `loadExtensionBundle`, `ui-presentation`, `extensions run` and the per-package `init` commands are removed.
