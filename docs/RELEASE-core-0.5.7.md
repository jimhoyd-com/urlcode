# URLCode core 0.5.7

@jimhoyd/urlcode uses this explicitly selected stable version. Independent package versioning remains enabled.

```sh
npm install --save-exact @jimhoyd/urlcode@0.5.7
```

## Changes

<!-- github-release-notes:start -->
### infra-release-hardening.md

Installer, container and server hardening:

- `install.sh` no longer claims to check a signed `SHA256SUMS`; the header now
  says plainly that the checksum is same-origin (catches corruption, not a
  substituted origin), and a new opt-in `--verify-attestation` flag checks the
  release's real signed GitHub attestation with `gh attestation verify`.
  `URLCODE_DOWNLOAD_BASE` must be `https://` (loopback `http://`/`file://`
  still allowed for local mirrors and the installer's own test), transport is
  pinned (`curl --proto '=https' --tlsv1.2`, `wget --https-only`), and the
  whole script now runs inside a `main()` called on the last line so a
  truncated `curl | sh` cannot execute a partial body.
- `urlcode serve`/`dev` read the listen port from the `PORT` environment
  variable when `--port` is not given, matching the common container/PaaS
  convention; the container image's `HEALTHCHECK` now reads the same `$PORT`
  it serves, so it stays correct when an operator changes the port with
  `-e PORT=`.
- `/_urlcode/health` and `/_urlcode/ready` no longer disclose the build
  version and route count by default; pass `--health-details` (or `--metrics`,
  which implies it) to include them, matching the existing guidance to keep
  `/_urlcode/*` behind an operator-only proxy restriction. `urlcode
  verify-deployment` needs `--health-details` (or `--metrics`) on the target
  it checks.
- Shutdown is now tunable: `--drain-delay-ms` (default `0`) reports
  `/_urlcode/ready` unhealthy for a bounded window before the listener stops
  accepting connections, so a load balancer can notice and stop routing here;
  `--close-timeout-ms` (default `10000`, unchanged) bounds how long in-flight
  connections get once accepting stops. `--headers-timeout-ms`,
  `--request-timeout-ms` and `--keep-alive-timeout-ms` expose the server's
  previously-fixed HTTP timeouts. `serve`'s SIGINT/SIGTERM handler now catches
  a shutdown failure and sets a non-zero exit code instead of leaving an
  unhandled rejection, and the CLI installs a process-wide `unhandledRejection`
  handler that logs a structured event and exits non-zero.
- `.github/dependabot.yml`'s `docker` ecosystem now points at
  `/packaging/container`, where the only Dockerfile actually lives, so base
  image digest updates are proposed again.
<!-- github-release-notes:end -->

Publish to the npm `latest` channel only after exact-commit CI and candidate verification. Existing tags and the `alpha` channel stay unchanged. Update the standalone starter after core registry installability is verified. This preparation is not evidence of publication or an independent security assessment.
