# URLCode 0.4.9

Core, UI, auth, admin and store share this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.9 @jimhoyd/urlcode-ui@0.4.9 @jimhoyd/urlcode-auth@0.4.9 @jimhoyd/urlcode-admin@0.4.9 @jimhoyd/urlcode-store@0.4.9
```

## Changes

<!-- github-release-notes:start -->
Add verified executable extension-bundle initialization. `urlcode init --with
... --bundle-release extension-bundles@v…` verifies and locks the selected
first-party bundles, then generates an explicit bundle-loading host. Generated
sites pin core and do not install executable extension packages from npm.
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
