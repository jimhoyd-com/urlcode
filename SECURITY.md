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
The host owns CSP and must not enable `unsafe-inline` for scripts. Its toggle is
hidden until enhancement is available; no-script pages retain system CSS themes.

## The kit and the host entry

Project template, copy, theme and stylesheet files are untrusted content the
kit confines: templates are data in a language with no expressions, no logic
and no raw output; every placed value is escaped and only renderer-produced
`Markup` passes; link targets go through `href`, which yields `#` for anything
but same-site paths, fragments, queries and `http(s)` URLs; theme values match
a narrow grammar; catalogues may only override existing keys and are bounded
(1024 keys per registered source, 4096 keys and 512 KiB per effective
catalogue, every key and message bounded on its own); files must resolve
inside the project after symlink resolution and are bounded in count and size;
a stylesheet containing `<script`, `javascript:`, `expression(` or `@import` is
refused. Pages send `default-src 'none'` with nonce-bound style and scripts, so
a template cannot add a script or load a remote resource. An extension may
name at most eight scripts per page, each a same-site path under its own
mount (no scheme or host; `safeHref` must return it unchanged) with an
optional integrity value; they carry the page nonce like the kit's scripts.
Navigation icons come from the package's `IconName` allowlist only.
Rendering is bounded.
A project stylesheet can still restyle anything, including hiding a notice:
styling is not a security control. The `ui` extension and the host file are
trusted operator code; the runtime forces `no-store` on their responses.

This repository follows the [core URLCode security policy](https://github.com/jimhoyd-com/urlcode/blob/main/SECURITY.md) for reporting and support baseline.
