# Security

There are no released runtime versions to support yet. This repository is a
public design foundation, not production software. A private vulnerability
reporting channel and supported-version policy will be published before the
first executable release.

Do not post credentials, private deployment details or exploit-sensitive
reports in public issues. For now, public issues may discuss general security
design without sensitive information.

Planned controls include explicit secret references, redacted output, strict
configuration validation, safe URL handling and least-privilege deployment.
Local execution of operator-authored functions will not imply a security
sandbox for untrusted users. Multi-tenant isolation requires separate verified
controls before it can be advertised.
