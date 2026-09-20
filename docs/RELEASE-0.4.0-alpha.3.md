# Coordinated 0.4.0-alpha.3 release

This release prepares core, UI, auth and admin at `0.4.0-alpha.3`, as explicitly
selected by the maintainer. The shared number identifies this tested package
set; it does not enable permanent fixed versioning or leave the alpha channel.
Existing versions, tags, and npm `latest` channels are preserved.

## Included changes

Core includes the monorepo consolidation, corrected Windows npm invocation,
current trust-by-default authoring guidance, and support for a TypeScript module
shared by trusted and sandboxed routes without weakening the sandbox checks.
The CLI and MCP report the new runtime version. The runtime remains independent
of the extension implementations.

Auth includes deterministic worker cleanup on rejected initialization and
Windows backup flushing. Auth/admin refresh a lifecycle hook's entry module on
each activation; changes to the entry module's own imports still require restart.
The extension changelogs record their package-specific changes.

All four packages use the shared release coordinator, immutable release tags,
exact-commit full verification, retained retry artifacts and trusted npm
publication. The candidate rehearsal installs their tarballs together outside
the workspace and checks peers, public imports and scaffolding.

## Installation and compatibility

Once publication has completed, install an exact, coordinated set in the
consumer application's directory:

```sh
npm install --save-exact @jimhoyd/urlcode@0.4.0-alpha.3 @jimhoyd/urlcode-ui@0.4.0-alpha.3 @jimhoyd/urlcode-auth@0.4.0-alpha.3 @jimhoyd/urlcode-admin@0.4.0-alpha.3
```

Applications only need the extensions they actually use; admin requires auth
and UI, and auth requires UI. Auth/admin peer floors for this release are
`>=0.4.0-alpha.3 <0.5.0`. Update their dependencies together when crossing from
the former `0.1.x` extension line. Commit the resulting lockfile and use `npm ci`
in deployment. This release changes package peer compatibility intentionally;
it does not imply all previously mixed versions are supported.

Publication order is core, UI, auth, admin. A partial release stops before the
next package; diagnose and rerun its original workflow without moving tags.
The standalone template remains an exact core consumer and is updated through
its own PR after core is published. Archived extension repositories are not
publication targets.

CI and candidate success are not independent security assessment, live-provider
acceptance, or operational recovery proof. The intermittent Windows startup
timeout remains tracked in #202.
