# Security

0.1.0-alpha.1 is an early executable implementation, not a supported stable
production release. A supported-version and private vulnerability reporting
policy still needs to be established before a stable release. Do not post
credentials or exploit-sensitive reports in public issues.

Configuration is trusted operator input. Function modules and dependencies are
trusted code with Node filesystem/network/environment access. Worker threads
provide deadlines and crash recovery, not tenant/security isolation. Never use
this runtime to execute arbitrary users' submitted functions in a shared process.

Strict schema/input validation, contained entry paths, bounded HTTP bodies,
function deadlines, generic errors, secret-free runtime logs and transactional
reloads are implemented and tested. These controls do not establish a full
security audit or prevent trusted code intentionally disclosing credentials.
Function stdout/stderr are suppressed; app-specific logging requires deliberate
safe instrumentation. Do not put secret values in route YAML or response URLs.

Bind loopback by default. For internet exposure use an HTTPS reverse proxy,
network/firewall controls and appropriate rate limits. Restrict operational
endpoints and inject only the secrets needed by the application process.
See [operations](docs/OPERATIONS.md) for limits, readiness, rotation and rollback.
Do not commit `.env.local`; artifact builds should use explicit file allowlists.
