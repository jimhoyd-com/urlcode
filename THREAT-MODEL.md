# UI kit threat model

Scope: the kit, its `ui` extension and CLI, beside the shared primitives whose
boundary SECURITY.md already states. Assets: the integrity of every page an extension serves (no injected script,
no spoofed controls), the confidentiality of the values placed in pages, and
the operator's host. Trusted: the kit, extension templates, the host file.
Untrusted: project template, copy, theme and stylesheet files; every view
value; every request.

| Threat | Enforced boundary |
| --- | --- |
| Data placed in a page carries markup or script | Escaping of every value; only renderer-produced `Markup` passes; attribute values quoted and escaped |
| A project template adds a script or loads a remote resource | No expression or raw syntax in the language; CSP `default-src 'none'` with nonce-bound style and scripts; only kit assets referenced |
| A link target runs script or leaves the site | `href` helper yields `#` for anything but same-site paths, fragments, queries and `http(s)` URLs |
| A theme value injects CSS or a URL | Grammar-validated colours, radius, font and local asset paths |
| A project file escapes the project directory or exhausts memory | Relative paths only, realpath containment, symlinks ignored, bounded file counts and sizes |
| A translation invents keys or changes placeholders | Only existing keys may be overridden; placeholders validated; `doctor` reports mismatches |
| Runaway rendering | Bounded source size, nesting, partial depth, iterations and output |
| Stale ejected templates render against a changed view model | Missing values are errors, never silent blanks; `doctor` names templates behind their view model version |
| Cached authenticated pages | `no-store` on every page; the runtime enforces the same on extension responses |
| A project stylesheet hides a security notice | Not prevented: styling is not a control; documented as an operator responsibility |

Changes must add tests for escaping, the language's rejections, theme and
path validation, loader containment and the rendering limits. Run
`npm run verify`. Accessibility, browser and screen-reader behaviour need
manual verification; the automated checks cover structure only.
