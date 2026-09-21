# URLCode 0.5.0

Core, UI, auth, admin and store share this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.5.0 @jimhoyd/urlcode-ui@0.5.0 @jimhoyd/urlcode-auth@0.5.0 @jimhoyd/urlcode-admin@0.5.0 @jimhoyd/urlcode-store@0.5.0
```

## Changes

<!-- github-release-notes:start -->
Core adds verified executable first-party extension bundles. `urlcode init
--with ... --bundle-release extension-bundles@v…` verifies and locks selected
bundles, generates an explicit bundle-loading host, and leaves executable
extension packages out of the generated site's npm dependencies.

Redirects now support root-relative destinations and redirect-only terminal
`/**` suffix wildcards with an encoded `{**}` capture. Functions without an
explicit `args` map bind declared path inputs, and trusted and sandboxed
functions receive the matched route pattern in `context.route.pattern`.

`init --template page` now writes `AGENTS.md` and `.mcp.json`; pinned projects'
MCP command uses the installed runtime without fetching from npm.
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
