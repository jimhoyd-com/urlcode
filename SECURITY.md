# Security boundary

Presentation is a security boundary: escaping, URL handling and script construction
can affect account safety. This package owns no identities, credentials, sessions,
CSRF policy, authorization, HTTP headers, storage or network calls. Those remain
with the consuming runtime/extension.

Primitive values and catalogue substitutions are plain text and escaped by renderers.
`renderDocument.trustedContent` is explicitly trusted package markup, not a sanitizer:
never pass user/project HTML there. No template code, filesystem template discovery,
raw project scripts, arbitrary CSS or host-module evaluation is supported.

Use createPresentation to validate and snapshot catalogues/theme values; do not forge
contexts from request JSON. Scripts require explicit trusted URLs/nonces, and the
consumer must supply a matching restrictive CSP. Do not put secrets in presentation
models. Same-origin frontend scripts remain trusted by the browser.

Automated semantic checks and browser walkthroughs are not a WCAG conformance or
independent security assessment. Native-reviewed language packs are not bundled.
Report sensitive vulnerabilities privately; never include credentials in issues.

The optional appearance enhancement is a fixed package-owned inline script, bound
to a host-generated CSP nonce. It reads/writes only `urlcode-ui.theme` with values
`system`, `light`, `dark`; it never handles credentials, network calls or raw HTML.
The host owns CSP and must not enable `unsafe-inline` for scripts. Its selector is
hidden until enhancement is available; no-script pages retain system CSS themes.
