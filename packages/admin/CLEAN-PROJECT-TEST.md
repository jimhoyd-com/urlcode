# Sequential clean-project acceptance

Run this harness with four reviewed, built local tarballs. It never publishes
packages. The output directory must not already exist; npm may need network access
for the tarballs' declared dependencies.

```sh
node scripts/clean-project-acceptance.mjs \
  --core /absolute/packages/urlcode.tgz \
  --ui /absolute/packages/urlcode-ui.tgz \
  --auth /absolute/packages/urlcode-auth.tgz \
  --admin /absolute/packages/urlcode-admin.tgz \
  --out /private/tmp/urlcode-clean-acceptance-new \
  --hostname localhost \
  --keep
```

`--kit` registers the auth and admin kit templates through the installed UI host
extension, verifies the immutable hashed stylesheet and checks compact auth versus
application admin layout. **The admin phase now requires `--kit`**: the console
renders only through the kit, so `adminExtension` refuses to activate without it
and the harness stops with that message rather than running an unkitted admin
phase. Each result and browser fixture still names its render path. These runs use
separate databases and synthetic sessions.

The first stage installs only core and calls its shipped `initProject`. It adds a
simple application route, starts a real loopback HTTP listener and checks it. The
second stage installs UI and auth into that same npm project, renders a shared UI
page and serves it through core before activating any auth extension, adds explicitly
revision-pinned auth routes to the existing starter, and checks HTTP registration,
sign-in, account HTML and protected application access. The third stage installs
admin in place, reopens the same private SQLite database, and verifies both
accounts and an already-issued member session survived, including unchanged account
identity before reauthentication. It checks anonymous/member denial, administrator dashboard and
user/session views, revocation of member sessions, reauthentication and health.
The original route and a pre-auth project marker must survive every stage.

All modules resolve through installed compiled default exports. Source symlinks
are rejected and the subprocesses clear `NODE_OPTIONS`, so development export
conditions cannot substitute source code for packaged code. `source-manifest.json`
records each tarball SHA-256; the three `*-results.json` files record checks that
actually passed. A failure exits nonzero and leaves the directory for inspection.

`--hostname localhost` uses a cookie host distinct from an existing `127.0.0.1`
fixture. Both permitted names bind only to loopback; arbitrary hostnames are
rejected. The default remains `127.0.0.1`. Cookies are shared across ports on the
same hostname, so isolate a browser test from an active user fixture by using the
other permitted hostname.

`--keep` leaves the final host alive for an actual browser walkthrough. Read the
mode-0600 `browser-fixture.json` in the output directory for the loopback origin,
process ID and synthetic owner/member credentials. Open `/account/login`, sign in,
then visit `/private` and `/admin`. Stop the host with Ctrl-C or SIGTERM to its
recorded process ID. Without `--keep`, each host closes after its checks. The
fixture uses only reserved `.test` addresses and no email or provider transport.

This is a local integration fixture, not a production host or a production preset.
It uses loopback HTTP and deliberately opens password registration without email
verification to exercise the complete offline path. Its small HTTP adapter is
only for these bounded synthetic tests; production should use the reviewed host
and TLS/proxy configuration. Operator modules, encryption/CSRF keys and SQLite
remain outside `app/`. Fresh project hashes are computed for test-controlled
configuration after each stage; deployments still require explicit operator
review and approval of their project revision.

Passing does not establish live OIDC/email-provider compatibility, accessibility
conformance, recovery/soak behavior, hostile multi-tenant readiness or independent
security review. Browser observations and the exact reviewed commit/tarball hashes
should accompany the final acceptance report. Do not attach the fixture database,
keys or credentials to public issues.

## Browser acceptance after the automated checks

With the retained fixture, check both a desktop and a narrow viewport. Open
`/welcome` while signed out to confirm core uses the shared UI independently.
Open `/private` signed out and confirm access is denied. At `/account/login`,
sign in with the synthetic member and inspect `/account/account` and `/private`;
`/admin` must remain unavailable. Sign out, sign in as the synthetic owner, then
inspect `/admin`, `/admin/users`, an account detail and `/admin/sessions`. Confirm
labels, keyboard focus, navigation, readable errors and absence of horizontal
overflow. Record actual observations separately; the HTTP harness does not claim
to automate these browser/accessibility checks. The private session continuity
fixture is synthetic but still contains usable local cookies: do not publish it.
