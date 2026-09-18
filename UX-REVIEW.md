# Authentication UX review

Reviewed identifier entry, password entry, optional second factors, provider and
passkey choices, signup, verification, recovery, enrollment, account settings,
session controls and failure states. The visual direction is the centered,
neutral card and email-first patterns at https://ui.shadcn.com/blocks/login.
Auth-specific screens and copy remain in this repository; URLCode UI owns the
shared styles, fields, document layout and appearance preference.

## Changes

| Flow | Finding | Implemented behavior |
| --- | --- | --- |
| Identifier entry | The next screen repeated sign-in choices and an email input. | Email first; the next screen has its own password heading, selected email and Change link. Provider/passkey choices remain on entry only. |
| Password | Optional authenticator and recovery fields overwhelmed ordinary sign-in. | Password is the primary visible input. Two-step verification is a closed, optional disclosure; the server still enforces configured factors. |
| Failed sign-in | Generic error page lost context and offered no continuation. | Browser 401 retains only the submitted email, never the password or factor proofs, and offers retry/change routes, with password reset only when configured. JSON failure semantics remain unchanged. |
| Signup identifier | Steps and subsequent requirements were unclear. | Policy-aware progress and introduction explain verification only when enabled; invitation controls remain policy-controlled. |
| Signup credentials | Generic heading, long label and two equally prominent actions. | Current-step heading, selected email, associated password-rule hint, primary Continue and secondary passkey/restart actions. |
| Signup profile | Waitlist completion incorrectly looked like immediate account creation. | Waitlist copy and Request account CTA explain administrator approval. Ordinary signup describes details and any required terms. |
| Signup navigation | No direct return to sign-in and restart was prominent. | Sign-in crosslink on every step; restart explanation inside a secondary disclosure. |
| Password/factor recovery | Successful browser submissions could show raw JSON. | Browser confirmation screens explain email delivery eligibility and next steps. JSON clients retain their response envelopes. |
| Authenticator settings | Disable controls appeared before enrollment. | Setup is shown only while disabled; enrolled accounts show disable controls inside a disclosure. |
| Account mutations | Several browser actions ended at JSON rather than a usable screen. | Profile/method changes return to settings; confirmation screens cover cancellation, verification, session revocation, email change and scheduled deletion. Data export remains a JSON download. |
| Other failures | A generic error stranded users. | Contextual retry links return to signup, sign-in, recovery or settings without reflecting passwords or token-bearing URLs. |
| Appearance | No user-selected light/dark mode. | The shared System/Light/Dark selector uses a fresh nonce matching the auth CSP. No unrestricted inline scripts are permitted. |

## Security and behavior preserved

Identifier screens do not query account existence. Unknown and existing users
receive the same entry controls. Signup email context comes from the existing
browser-bound signup flow and does not expose whether an account exists.
Verification-first order, transaction checks, invitation binding, waitlist approval,
CSRF, session rotation, factor enforcement and recovery cooldowns are unchanged.
There is no new post-password authorization state: optional factor controls still
submit to the existing atomic authentication operation. Provider buttons are only
rendered for configured providers. Theme storage contains appearance preference,
not credentials. All new product copy is catalogued and escaped.

## Verification and limits

Regression tests cover the identifier/password separation, collapsed factor
controls, password-free retry responses, reset confirmation, current signup step,
password hint association, secondary restart action and nonce/CSP agreement.
Run `npm run verify` for the full typecheck/build/security and HTTP suite. Browser
review and packed core → auth → admin acceptance must use the resulting reviewed
commits; see the parent ecosystem acceptance report for that evidence.

Live identity/email-provider delivery, browser/device WebAuthn coverage, complete
accessibility assessment and independent security review remain separate work.
The MFA disclosure intentionally does not claim a new two-stage backend protocol.
