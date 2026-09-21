# URLCode core 0.4.8

@jimhoyd/urlcode uses this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.8
```

## Changes

<!-- github-release-notes:start -->
### quiet-signed-artifacts.md

Ship the signed declarative extension-artifact CLI, bind attestation verification to the requested immutable release tag, and expose verified locked artifact data through bounded read-only MCP tools and matching agent guidance.
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
