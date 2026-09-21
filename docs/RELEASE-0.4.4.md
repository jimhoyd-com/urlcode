# URLCode 0.4.4

> **Never published.** The `v0.4.4` tag exists, but its publisher stopped at the preflight (the peer-floor guard held core itself to a floor it cannot have), before anything reached npm. Its changes ship in 0.4.6 (0.4.5 was also never published).

Core, UI, auth, admin and store share this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.4 @jimhoyd/urlcode-ui@0.4.4 @jimhoyd/urlcode-auth@0.4.4 @jimhoyd/urlcode-admin@0.4.4 @jimhoyd/urlcode-store@0.4.4
```

## Changes

<!-- github-release-notes:start -->
### release-0.4.4-includes-0.4.3.md

Version 0.4.3 was prepared but never published: its candidate build failed in the release container because two checks called `git ls-files` on a checkout owned by another user, which git refuses as dubious ownership. Nothing was tagged or published for 0.4.3. This release fixes those checks and carries every change prepared for 0.4.3, listed in `docs/RELEASE-0.4.3.md`, on top of 0.4.2. Highlights: `request.body.schema` validation and `shared` blocks, multi-step fixtures and a quiet `urlcode test`, an unordered `init --with` with a generic `--ack`, the store collection sorting and filtering, the data-bound CRUD screen, and the first store extension release line.
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
