# Presentation review and acceptance criteria

Reference: shadcn login blocks (https://ui.shadcn.com/blocks/login), neutral demo
style, and the official installation/theming guidance. Reviewed 2026-09-18.
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
- Focus rings, reduced-motion support, native disclosures, mobile navigation and
  scrollable tables preserve keyboard/native browser behavior. Hosts provide
  appropriate skip targets when surrounding page content with application chrome.

## Acceptance

Verify sign-in identifier → password and signup steps with realistic state,
empty/error/success screens, primary/secondary hierarchy, desktop and 390px width,
light/dark/system persistence across navigation and reload, blocked storage,
contrast of text/control/focus states, and the clean tarball core/auth/admin
installation. Unit checks cover nonce binding, storage/system state transitions,
localization and injection boundaries. Browser evidence is recorded on the PR.

This review is not a complete screen-reader certification. Native language review,
live identity-provider behavior and high-contrast/forced-color platform coverage
remain separate validation work.
