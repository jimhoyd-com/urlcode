# URLCode core 0.5.4

@jimhoyd/urlcode uses this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.5.4
```

## Changes

<!-- github-release-notes:start -->
### review-project.md

Add `review_project` (MCP) and `urlcode review` (CLI), an opt-in, read-only static review of a compiled project and its own function/middleware source. It reports a conservative, well-tested subset of signals — hand-written JSON body validation duplicating `request.body.schema`, manually assembled `Set-Cookie`/session construction, module-scope mutable state, and direct outbound network calls — grouped as `native-alternative`, `extension-alternative`, `gap` or `manual-review`. It never executes project code, reads an environment variable or secret, makes a network call, or claims a declared-but-unregistered extension is active. Refs #428.
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
