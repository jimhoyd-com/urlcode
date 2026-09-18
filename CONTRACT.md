# Shared UI contract, version 1

Core, auth and admin may consume the same dependency-free package. This package
must never depend on any of them. Its main exports use standard Web/Intl APIs,
with no Node imports, browser DOM requirement, network calls or client framework.

- `createPresentation`: bounded immutable catalogues, custom default messages,
  account/query/Accept-Language/default negotiation, English fallback, Intl plurals
  and numbers, RTL direction, constrained local assets and theme variables.
- `renderDocument`: shared HTML document, skip link, main landmark, title, responsive
  CSS and explicit nonce-bearing script tags. Caller owns HTTP/security headers.
- `field`, `button`, `alert`, `navigation`, `table`, `pagination`, `emptyState`:
  escaped values and semantic HTML. Fields associate hints/errors with controls.
- `stylesheet`: shared CSS with logical properties, focus indicators and dark mode.
- `escapeHtml`: text/attribute escaping, not authorization or URL validation.

Only generic --ui-* theme variables live here. Legacy auth theme aliases are
adapted in urlcode-auth. Auth owns its catalogue IDs and composes them into the
shared factory; core can register its own defaults without importing auth. The auth
and admin workflows, notices, validation, secrets, CSP and CSRF never move here.

This is the agreed extraction from the working implementations, not every feature
in the earlier SPIKE-UI proposal. Arbitrary project templates, template evaluation,
eject/preview tooling, framework markup dependencies and a UI YAML owner are not
implemented. Tailwind CSS is compiled at build time and embedded by the shared document renderer.
The shadcn Button/Input/Card recipes are adapted to server HTML (see THIRD-PARTY-NOTICES.md).
Document layouts are generic default, compact and application variants. No claim
of full WCAG 2.2 AA conformance follows from semantic markup tests.
