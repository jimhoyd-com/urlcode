# Administration UX review

This review covers the HTML console, its source routes and focused regression
checks. It is a usability and accessibility pass, not WCAG certification or an
independent security assessment. The console uses shared URLCode UI primitives;
account terminology, permissions, workflows and copy remain in this repository.

| Screen or concern | Finding | Change |
| --- | --- | --- |
| Shared shell | The skip link stopped before the sidebar; the visible title was an h2 below a hidden h1. | One visible page h1 and a focusable content target after navigation. Native mobile navigation stays collapsed until opened. Security response headers and theme scripts are preserved. |
| Overview | Exact-value tables could overflow and an empty event list gave no explanation. | Keyboard-focusable table regions and explicit empty activity feedback. Metric links retain permission filtering. |
| Users | Lock/revoke controls had the same visual weight as search; identifiers and dates were dense. | Destructive button treatment, concise UTC dates with exact machine-readable timestamps, masked identifiers, expandable actions, and retained filter selections. Default search fields keep advanced filters closed. |
| Account details | Notes, session revocation and identifier reveal competed with account facts; recovery links appeared when no delivery integration existed. | Clear fact grid, section navigation, expandable sensitive actions, note guidance, empty states, and recovery links gated by actual availability. Consent records and user content remain escaped. |
| Roles | Ungrouped role/grant lists and assignment fields obscured the read-only policy boundary. | Permission table plus a separate assignment card, descriptive empty grants and explicit read-only configuration explanation. |
| Sessions | Long prose lists mixed identity, dates and immediate revoke forms. | Filter card, table with masked accounts and readable timestamps, empty results, expandable destructive actions and a separate revoke-all section. |
| Audit | Submitted filters were not retained, labels exposed raw parameter names and export competed with filtering. | Persistent input values, human-readable labels, explicit UTC format, scrollable event table, empty state, and separate export disclosure. |
| Health | Raw enum alerts and missing empty states made a configured-but-quiet service look unfinished. | Grouped facts, status badges, plain-language alert copy and explicit absence of reported alerts. Unknown sender/provider observations remain unknown. |
| Support cases | All mutation forms appeared at once, and action input was free text. | Case cards with expandable notes/closure/approval, a constrained action select and empty queue feedback. Two-person authority checks are unchanged. |
| Registration | An empty queue rendered no content. | Explicit empty queue feedback and a separate invitation card when delivery is configured. |
| Account operations | Every destructive operation showed a full form immediately. | Grouped methods and expandable action cards; password invalidation, deletion and method removal use destructive styling. Existing typed confirmations, reasons and notification gates remain required. |
| Manual recovery | Empty lists and long identifiers weakened hierarchy. | Explicit empty state, bounded evidence cards, readable identifiers, grouped creation and destructive approval styling. Evidence is still a human procedure, never automatic proof. |
| Completed mutations | Confirmation pages left no clear next step. | Status feedback and a return link to overview or users. |
| Copy ownership | New console text could not be translated without extending auth's nearly full catalogue. | Admin owns a separate bounded catalogue and a presentation factory that composes it with existing auth copy, without raising shared catalogue limits. |

## Verification

`npm run verify` passes 36 tests, including existing authorization, CSRF, freshness,
notification, recovery, export and HTTP integration regressions. Added checks cover
all principal console pages sharing one h1 and the skip target, preserved audit
filters, meaningful empty states, unavailable recovery-link omission, destructive
session forms retaining CSRF/reason fields, and admin-owned translation overrides.

The final reviewed-package browser pass must additionally check desktop and narrow
layouts, keyboard focus, mobile navigation, light/dark/system themes, long labels,
empty/populated tables and provider-dependent screens. Typeface, palette, control
sizing and theme behavior are supplied by URLCode UI and need verification at the
exact integrated package revision. No live email/OIDC provider verification,
comprehensive screen-reader audit or production data/soak validation is claimed.

Error responses still use the shared auth failure renderer to preserve its
redaction and security behavior. JSON schemas and authority decisions are
unchanged. Historic method/activity timestamps remain unknown rather than invented.
