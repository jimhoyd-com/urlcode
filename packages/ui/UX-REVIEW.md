# Presentation review and acceptance criteria

Reference: shadcn login and dashboard blocks (https://ui.shadcn.com/blocks),
neutral demo style, and the official component and theming guidance. The
composition pass was repeated with the official shadcn skill on 2026-09-20.
Auth workflow references: Clerk custom email/password flow; public GitHub,
Airbnb and Uber sign-in entry pages. These illustrate focused entry and clear
recovery paths, not identical authentication protocols.

## Findings and changes

- The previous teal/slate palette did not match the requested shadcn neutral
  aesthetic. Replaced it with neutral surfaces, subtle borders and clear contrast.
- Small secondary text and 14px fields made dense pages and phone forms harder to
  read. Body and inputs now use 16px; labels 15px and secondary copy 14px. Table
  metadata stays at least 13px. Touch controls have a 44px minimum target height.
- All buttons looked equally important. Explicit secondary and destructive
  variants now support a single clear primary action per workflow.
- Dark mode followed system only and could not be overridden. A visible localized
  System/Light/Dark control now remembers only the bounded appearance preference
  locally, updates across tabs, follows system changes, and tolerates blocked
  storage. The default HTML still works without JavaScript.
- Theme enhancement is opt-in and uses a caller-supplied CSP nonce. No network,
  authentication storage, inline handlers or unsafe-inline script permission.
- Compact layouts now have consistent width, heading rhythm, field spacing,
  selected-identity summaries and step indicators. Auth-specific copy and flow
  state remain in auth; administrative composition remains in admin.
- Shared partials now expose the same semantic anatomy the shadcn components
  document: `data-slot` hooks for cards, fields, buttons, alerts, tables, empty
  states, dropdowns and the sidebar. These are additive styling hooks; escaped
  values, view ownership and server-side behavior remain unchanged.
- Auth identifier entry follows the official email-first block hierarchy:
  focused card, title and description, field group, one primary action,
  conditional alternative-method separator and secondary links. Admin follows
  the official dashboard hierarchy: inset sidebar, metric cards, chart card,
  activity card, badges and dense tables.
- Focus rings, reduced-motion support, native disclosures, mobile navigation and
  scrollable tables preserve keyboard/native browser behavior. Hosts provide
  appropriate skip targets when surrounding page content with application chrome.

## Acceptance

Verified sign-in and admin overview in the browser at desktop and 390px width,
including the provider alternative and a populated metrics/chart state. Continue
to verify identifier → password and signup steps with realistic state,
empty/error/success screens, primary/secondary hierarchy, desktop and 390px width,
light/dark/system persistence across navigation and reload, blocked storage,
contrast of text/control/focus states, and the clean tarball core/auth/admin
installation. Unit checks cover nonce binding, storage/system state transitions,
localization and injection boundaries. Browser evidence is recorded on the PR.

This review is not a complete screen-reader certification. Native language review,
live identity-provider behavior and high-contrast/forced-color platform coverage
remain separate validation work.
