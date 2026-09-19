# Admin threat model

The console is a privileged client of the separate auth service. Its main assets
are user ownership and access, identifiers, private exports, recovery evidence,
operator authority and the audit trail. The operator host, installed modules and
notification integration are trusted. Application functions and middleware
run trusted in Node by default; only `sandbox: true` opts into guest isolation.
Request fields remain untrusted in either mode. Host registration and filtered
headers do not confine trusted code with the process user's filesystem authority. Run beside trusted frontend content or use an isolated origin.

| Threat | Enforced boundary |
| --- | --- |
| Hidden UI controls bypassed through direct requests | Per-operation permissions plus service-side transactional authorization |
| Stolen, stale or remembered-device session used for mutations | Fresh real authentication; current roles and account state; impersonation/restricted-session denial |
| Support operator modifies a more privileged account | Delegation ceiling, self-mutation restrictions and last-administrator checks |
| Recovery reviewer restores the wrong account or colludes | Evidence recorded for a human procedure, distinct current approvers, target/actor versions, private delivery gate and audit; colluding authorized operators remain a trust risk |
| Identifier or export leakage | Masked defaults, non-PII cursors, audited reveal/export, no-store responses, bounded authorized exports |
| HTML, CSV or log injection | Escaped markup, plain evidence, neutralized spreadsheet cells and no raw provider exceptions |
| Impersonation used as a credential/admin bypass | Explicit opt-in, notice, short expiry, restricted authority, no security step-up |
| Operator callback stalls or misbehaves | Time/size/concurrency bounds and no activation before required delivery succeeds |

Every privileged write must be checked in the auth service's transaction. UI hiding,
CSRF and a prior role lookup are necessary context but do not replace that check.
Retain meaningful reasons and limit access to case notes and evidence. A case
reference is plain text: the console must not fetch uploaded URLs or pretend that
a two-person approval proves identity automatically.

Changes must test denied and racing requests, revocation and stale approvals,
partial delivery, masked outputs, typed bulk confirmations and all-or-nothing
operations. Run `npm run verify` and cross-package installed-consumer checks for
package/initializer changes. Review SECURITY.md and IMPLEMENTATION-STATUS.md.

Known deployment limits remain explicit: universal guest-page impersonation banners
require application integration; live providers and independent security,
accessibility, recovery and load/soak validation are separate evidence. CI cannot
establish those properties. No hostile multi-tenant readiness is claimed.
