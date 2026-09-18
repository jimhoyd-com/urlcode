# URLCode business suite spike

Date: 2026-09-18. Status: proposal, not an implemented contract or production claim.
Core inspected at `50790d3` (0.4.0-alpha.1), plus local auth, admin, UI and
shortener source/status files. Competitor research below is a documentation
review, not hands-on benchmarking. Features and commercial packaging can change.

## Recommendation

Build six independently released Apache-2.0 applications on URLCode:
`urlcode-cms`, `urlcode-blog`, `urlcode-short`, `urlcode-support`,
`urlcode-forms` and `urlcode-billing`. Use `@jimhoyd/urlcode-<name>` packages.
Rename the existing `urlcode-shortener` repository to **`urlcode-short`** and
publish it as **`@jimhoyd/urlcode-short`**, with CLI `urlcode-short` and logical
extension name `short`. This is the agreed naming/release direction; the remote
rename and npm publication have not happened as part of this documentation spike.
Each application has one domain service, an operator-installed runtime extension,
a CLI/API for agents, and a standalone launcher composing the same components.
Standalone means no separate URLCode installation/configuration exercise; it
still uses URLCode internally. Auth and admin are optional integrations.

CMS is the content foundation; blog is a CMS preset plus publishing features.
Support reuses CMS for its optional knowledge base, not for ticket storage.
Short reuses core's live-link engine. Forms owns submissions and lead intake;
billing owns payment-provider synchronization and entitlements. Reliable
notifications are a shared operator library/worker, initially developed with
forms and consumed by billing and support; they are not another login or console.
Core remains generic and never imports
these applications. Shared presentation stays in urlcode-ui, using the existing
Tailwind/shadcn style, themes, translations and safe templates.

Start with a single business per deployment and a durable Node host. Do not
promise hostile multi-tenant hosting, arbitrary edge deployment or enterprise
feature parity. Ship useful small products with explicit expansion points.

## What to learn from existing products

The selection covers publishing, structured/headless content, file-based content,
and commercial editorial workflows. It is a fit assessment, not a universal
ranking. Borrow product behavior; do not copy incompatible licensed code.

| Reference | Relevant strengths | URLCode decision |
|---|---|---|
| [WordPress](https://wordpress.org/about/features/) — open-source CMS | Familiar publishing, media, roles, themes and extensibility | Pages, media, preview and revisions are baseline; avoid an unrestricted runtime theme/plugin marketplace |
| [Ghost](https://ghost.org/help/manual/) — open-source publishing and managed hosting | Focused publication experience, newsletters and memberships | Blog should feel complete immediately; defer newsletter delivery and payment machinery to shared integrations |
| [Payload](https://payloadcms.com/docs/versions/overview), [access control](https://payloadcms.com/docs/access-control/overview) — open-source developer CMS | Drafts, versions and operation-specific permissions | Typed collections, explicit draft/published versions and authorization in the domain service |
| [Strapi](https://docs.strapi.io/) — open-source CMS with commercial offerings | Content types, APIs, localization and editor UI | Small schema vocabulary and API/UI parity; avoid a general backend generator in v1 |
| [Directus](https://docs.directus.io/reference/system/versions) — self-hostable/commercial data platform | Independent unpublished versions promoted into main content | Explicit revision promotion; don't turn CMS into a UI for arbitrary databases. Verify current license terms separately before reuse |
| [Decap](https://decapcms.org/docs/intro/) — open-source Git CMS | File ownership, Git workflow, editor preview and media | Keep Markdown portable and Git-friendly; production editors should not need Git credentials |
| [Grav](https://getgrav.org/headless) — open-source flat-file CMS | File-based content and API delivery | Closest content-storage reference; plain files must remain a first-class path |
| [Statamic](https://statamic.com/features) — commercial flat-file CMS offering | Editorial UI, flexible content modeling and file-oriented operation | A polished editor can coexist with file portability; avoid starting with a visual site builder |
| [Sanity](https://www.sanity.io/docs/content-lake/presenting-and-previewing-content) — commercial content platform | Separate published/draft/release perspectives | Preview must select a revision explicitly and never contaminate public caches |
| [Contentful](https://www.contentful.com/help/ai-automations/workflows/workflows-management/multiple-workflows-to-content-types/) — commercial content platform | Workflow specialization by content type/team | Begin with draft → review → publish; defer enterprise workflow builders |

Recommended balance: Grav/Decap portability, Ghost's focused publishing UX,
Payload's typed authorization, and a small portion of commercial revision and
review workflows. The differentiator is a safe, inspectable agent workflow with
an optional human console—not the longest checklist of CMS features.

| Support/link reference | Lesson to adopt | Deliberately later |
|---|---|---|
| [Zendesk routing](https://support.zendesk.com/hc/en-us/articles/6712096584090-Understanding-how-omnichannel-routing-uses-queues-to-route-work-to-agents) — commercial | Queues, assignment, priority and response deadlines | Skills/capacity routing across voice and social channels |
| [Zammad](https://zammad.com/en/product/features) — open-source help desk | Ticket lifecycle, team collaboration, knowledge base | Deep ITSM and highly configurable workflows |
| [Chatwoot](https://www.chatwoot.com/features/shared-inbox) — open-source support platform with hosted offering | Shared inbox, internal context and handoffs | Every channel and a live-chat transport in the first release |
| [Shlink](https://shlink.io/features/) — open-source shortener | API-centered link management, QR codes and visit reporting | Complex targeting before abuse controls are proven |
| [Dub](https://dub.co/docs) — commercial link attribution platform with public source | Polished link operations, bulk creation and integrations | Affiliate payouts, revenue attribution and partner programs |

## One application, three supported compositions

Installing an npm package alone must not activate privileged code. “Install and
it works” means the initializer discovers compatible installed packages and
writes explicit, reviewable host wiring. The operator activates it with a pinned
revision. No ambient discovery from untrusted route YAML.

| Installed integrations | Intended behavior |
|---|---|
| Neither auth nor admin | CMS/blog serve public content; short supports bounded anonymous creation; forms accepts public submissions; billing supports operator-managed customers and provider-hosted checkout; support exposes intake/public help. Operator CLI/API manages data. No public management console or unverified customer account access |
| Auth only | Account identity, scoped app APIs, optional restricted content, customer tickets and billing portal access. Leads can be explicitly linked to verified accounts. CLI/API remain full management surfaces |
| Admin only | Unsupported: admin requires auth. Initialization and activation reject this combination with an actionable error |
| Auth and admin | Integrated, permission-filtered management screens and shared accounts; domain services enforce every operation regardless of UI visibility |

**Confirmed product rule:** admin requires auth, matching its current required
peer and privileged service. Keep that dependency. Removing auth while admin is
configured must refuse activation. Protected content, private tickets and writes
also fail closed; removing admin alone should only remove the console.

For a complete standalone console, provide a recommended preset composing auth,
admin and the application. Also retain a minimal preset with neither. Do not
implement separate password/session systems for the applications.

Proposed package surfaces: domain service, host extension factory, `scaffold`,
CLI executable, optional admin module, schemas, fixtures and migration tools.
Auth/admin adapters should use optional dependencies or separate exports so the
minimal app does not import them. CMS is a real blog dependency; the public UI
library is acceptable as a shared rendering dependency.

## Markdown content and publishing

Pages, posts and knowledge-base articles use `.md` with validated frontmatter.
Operational records do not. A proposed file (CMS-owned schema, not core YAML):

```markdown
---
id: page_about
kind: page
slug: /about
title: About us
locale: en
status: draft
template: standard
---
# About us
A small business built on URLCode.
```

Stable IDs survive renames. Schema definitions live in a versioned CMS content
manifest; frontmatter cannot select modules, secrets, infrastructure or arbitrary
executable templates. Start with text, Markdown, boolean, number, date, enum,
media and reference fields. Validate references, unique slugs, locale variants,
reserved paths and bounded document sizes. Rich editing must round-trip the
supported Markdown subset without silently deleting unsupported syntax.

Support two explicit operating modes, never two competing sources of truth:

1. **File mode:** project authors edit Markdown in Git. A deterministic compiler
   produces a public-only artifact and ordinary core page/static routes. Validate,
   review/re-pin where required, then redeploy. No database is needed to serve it.
2. **Managed mode:** immutable Markdown revision blobs and media live in private
   operator storage. SQLite owns revision pointers, workflow, audit, jobs and
   indexes. UI/API/CLI write through one service using expected revisions. Export
   yields ordinary Markdown and a manifest; import is previewed and conflict-aware.
   Direct disk edits are an explicit import, never a concurrent hidden writer.

For managed publishing, commit a durable job referencing the approved revision;
render a complete immutable public artifact; validate it; atomically switch the
active artifact/release pointer through a trusted deployment adapter. A crash
must leave the previous release serving. Domain publish state is not reported
as live until activation is acknowledged. A lost acknowledgement is reconciled
by release ID. Store the previous release for rollback; index/search/sitemap
versions travel with it. Publishing groups can be added after single-release
atomicity is proven.

Core `serve` is a fixed snapshot. A file write alone is not a live publish.
Initially use controlled restart/redeployment of the public artifact. A future
generic activation API can improve this without allowing CMS to reapprove its
own changed execution grants. Separate public serving from the private editor
host when needed. Published pages are ordinary core assets, avoiding blanket
extension-cache relaxation. Private/member content stays behind authorization
and is never included in public exports, search indexes or static artifacts.

Disable raw HTML and MDX execution by default; sanitize generated links/markup,
escape frontmatter in templates and bound parser work. Rich components are a
small validated allowlist. Auth/admin browsers must not execute content-author
scripts on their origin. Use a separate preview origin/sandbox for potentially
active material. Media uploads need private quarantine, type/size validation,
image re-encoding where appropriate and explicit publication. Large media uses
operator-bound object storage, not a larger unbounded extension response.

## Application release scope

| Application | First production scope | Subsequent scope |
|---|---|---|
| CMS | Pages and small collections; Markdown editor/preview; media with alt text; navigation; drafts/review/publish; revision diff/restore; SEO metadata/canonicals; sitemap; slug redirects; bounded search; import/export; editor/publisher permissions; audit; static export | Scheduled release bundles, richer localization workflow, reusable structured blocks and provider media adapters |
| Blog | CMS post type and templates; authors/tags; archive/pagination; RSS/Atom; reading pages; social metadata; draft preview; publish scheduling through durable jobs; import/export | Newsletter integration, memberships through auth plus billing, moderated comments; no separate CMS engine |
| Short | Existing anonymous short-lived mode; authenticated ownership and CRUD; custom slug; expiration/disable; QR; tags; CSV import/export; bounded aggregate analytics; operator takedown and abuse reporting | Verified custom domains, campaigns, richer analytics; no affiliate product initially |
| Support | Email and web intake; ticket thread/status/priority; assignee/team queues; public replies vs private notes; safe attachments; search; macros; customer-scoped portal with auth; audit; delivery retries; basic response/resolution timing; optional CMS help center | Business-hours SLA calendars/escalation, automation rules, CSAT, chat and additional channels |
| Forms | Versioned forms; accessible hosted/embed views; server validation; spam/rate limits; durable submission receipt; minimal lead inbox; explicit consent evidence; export/deletion; notification outbox; signed webhook handoff | File uploads, branching/multi-step forms, richer routing and CRM connectors |
| Billing | One provider adapter; hosted checkout/customer portal; fixed recurring plan; authenticated customer binding when auth is present; durable verified webhook inbox; subscription reconciliation; local entitlements; operator inspection and recovery | One-time purchases, additional providers, usage billing, seats, coupons and tax/accounting integrations |

CMS localization-ready IDs/schema ship first; do not claim translated UI or
content until catalogues and workflows are tested. Scheduling requires durable
worker execution, restart catch-up and cancellation/version checks; it is not
an in-process timer. CMS does not need to block its first release on scheduling,
but the listed blog scope does.

Short migration: the existing `urlcode-shortener` demo is private/unpublished and marked
UNLICENSED, pins an old core archive, and has no auth/analytics. This proposal
records the requested direction to Apache-2.0 and public packages, but the
implementation PR must verify rights to existing assets/dependencies, add the
license/notices, migrate the package/runtime pin and preserve existing links,
expiry and QR behavior. Rename the existing repo without discarding its history. Reuse core's LinkStore and
conditional updates; keep ownership and domain metadata in the app with a
recoverable transaction/outbox strategy if stores are separate. Never let a
metadata failure leave an unauthorized active link. Redirect availability must
not depend on analytics delivery. Core link events are bounded observations,
not a guaranteed billing ledger. No preview-fetching arbitrary destinations.

Support tickets require transactional storage, not Markdown files. Separate
requester identity, staff identity, message visibility and delivery status.
Inbound adapters verify provider signatures; email From alone grants no portal
access. Deduplicate provider/message IDs, bound MIME parsing and attachments,
and prevent auto-reply loops. A transactional outbox sends only committed public
replies, retries with idempotency keys and exposes failures. Private notes never
enter mail, customer APIs, public search or AI prompts for customer replies.
Without auth, intake confirmation does not grant ticket read access; use the
operator CLI/API or explicitly configured scoped verification links. CMS absence
must leave tickets usable and simply remove the help center.

## Naming and release migration: urlcode-short

Treat the rename as a focused repository migration, followed by implementation
and then a release. The approved name does not waive existing release gates.

1. Inventory repo settings, CI references, Pages/container names, docs links,
   local remotes, npm metadata, lockfiles and executable names. Check the target
   repository/package name and publisher access before changing remote state.
2. Rename the existing GitHub repository to `urlcode-short`; retain issues,
   history, protected-branch settings and security reporting. Verify redirects
   and update first-party references explicitly. Update local checkout/remotes
   without moving a directory underneath active work.
3. Change package/bin/repository metadata and release workflows together. Use
   the current reviewed scoped core dependency, Apache-2.0 and required notices.
   Publish only `@jimhoyd/urlcode-short`; do not publish an old-name placeholder.
   If an old package was published since this inventory, document its supported
   migration/deprecation rather than assuming there are no consumers.
4. Keep public short URLs, stored codes, expiration and existing data paths
   unchanged. The branding change must not change a redirect hostname or add
   `/short` to existing URLs. Provide explicit, reversible config/schema migration
   where extension names or imports change; never silently reset the store.
5. Verify clean tarball installation, CLI/bin resolution, all composition modes,
   existing-link fixtures, upgrade/restore and container startup. Tag/publish
   from reviewed CI, inspect registry provenance and install the actual published
   version in the dogfood deployment. Update framework/agent docs afterward.

## Forms and lead capture: urlcode-forms

First dogfood use: contact, early-access and product-interest forms on our own
site. A lead is a business contact/submission, not an auth account or a mailing
list subscription. Start with a usable inbox rather than waiting for a full CRM.

The domain owns `FormDefinition`, immutable `FormVersion`, `Submission`,
`ConsentEvidence`, `Lead` and an outbox. Form definitions are versioned JSON/YAML
validated by the app; core YAML only declares routes/extensions. Each submission
records the exact form version and notice version shown. Allow text, email,
textarea, enum, checkbox and bounded numbers first. Validate on the server,
reject unknown fields, and avoid sensitive fields by default. No arbitrary JS,
remote validation callbacks or user-supplied notification destinations.

Public rendering and POST handling live under an exclusive `/forms/*` extension
mount. CMS embeds a generated accessible form or links to a hosted form; API
clients use a documented JSON endpoint with the same validation. An allowlisted
origin policy controls browser embeds, but is not an abuse defense by itself.
Use bounded body/field lengths, per-form admission limits, honeypots and optional
operator-bound challenges. CSRF protection applies to authenticated management;
public submissions need their own abuse controls. No uploads in the first slice.

Acceptance means a submission and notification intent commit atomically before
a receipt is returned. Submission retries with the same idempotency key and
payload return the same receipt; changed payloads with that key conflict. Spam
can be quarantined without emailing staff. The receipt reveals no inbox content
or account existence. Email outage must not lose the lead or claim delivery.

The inbox provides new/contacted/qualified/closed states, assignment, notes,
filters and CSV/JSON export with spreadsheet-formula injection protection.
Email matching may suggest a merge, but must not auto-link to an auth principal
or merge unrelated contacts. Record consent purpose, notice version and time;
marketing opt-in is separate and defaults off. Retention, export and deletion
cover attachments when later enabled and downstream delivery metadata, with
explicit backup retention limits. Metrics distinguish accepted, quarantined,
notified and followed-up counts.

Host-configured handoffs use a durable outbox: lead creation, support-ticket
creation or CRM export. Consumers deduplicate by submission/event ID. Never make
an arbitrary guest-supplied webhook URL a privileged network destination. Admin
screens live at `/admin/forms`; without admin the CLI/API can do every operation.
Definition edits and bulk export require separate permissions. Drafting a reply
is distinct from authorizing it to be sent.

## Billing and entitlements: urlcode-billing

First dogfood use: one paid recurring offering with a clear free baseline. Keep
plan prices and the precise paid feature set outside this spike until the
business chooses them. Prove purchase → access → cancellation → access change
in provider test mode before accepting money.

Choose Stripe as the first proposed adapter, behind a small provider interface;
this is an implementation recommendation, not an account configuration decision.
Use hosted checkout and the provider portal. Server-side operator configuration
maps logical plans/features to allowed provider price IDs; a browser cannot set
an amount, select an arbitrary price or assert that it paid. Credentials, API
version and provider endpoints remain operator configuration. Cards and payment
method data stay with the payment provider.

Own `BillingCustomer`, stable business subject ID, provider mapping,
`SubscriptionProjection`, `EntitlementGrant`, webhook inbox, reconciliation
cursor and audit. An auth user can be a verified member/owner of a billing
subject, but email equality never proves ownership. Start with one owner per
customer; leave organization/seat management later. Without auth, operators
manage stable external subjects through the CLI/API; public checkout does not
automatically create an account or expose a customer portal. Portal sessions
require a verified authenticated mapping or an explicit operator workflow.

[Stripe webhook guidance](https://docs.stripe.com/webhooks) documents signature
verification using the raw payload, duplicate events and unordered delivery.
Our receiver validates the signature, account/environment and event size, then
durably inserts an inbox record before acknowledging. Workers process retries;
event IDs and domain transition keys prevent repeated effects. Test/live stores
and keys are separate. Return URLs are allowlisted; checkout success redirects
are never evidence for granting access.

Reconciliation fetches authoritative current provider state, serializes updates
per subscription and prevents stale workers from overwriting newer projections.
A periodic full reconciliation recovers missed events; timestamps alone are not
an ordering guarantee. Operator tooling reports mismatches and supports dry-run
repair. Pin the provider API contract and test historical payload versions.
[Stripe entitlements](https://docs.stripe.com/billing/entitlements) are one possible
adapter input; the app-facing feature contract stays provider-neutral.

Proposed default lifecycle, configurable only through reviewed operator policy:

| Payment state | Access behavior |
|---|---|
| Checkout pending/incomplete | Free baseline; no paid access |
| Active and payment requirements satisfied | Grant versioned features through their recorded validity |
| Trial | Disabled initially; explicit finite trial policy if added |
| Payment past due | Keep existing grants only within a configured finite grace period; do not grant new capacity |
| Cancel at period end | Preserve already-paid access until the verified period end |
| Subscription ended/unpaid after grace | Revoke paid features; retain login, data export, billing and support access |
| Refund/dispute | Record and apply an explicit entitlement policy; no automatic content deletion |
| Provider unavailable or projection stale | Never invent new grants; retain known grants only within recorded validity/staleness bounds, then restrict paid operations |

Authorization is `principal permission AND entitlement`, enforced inside each
protected domain action. Entitlements do not grant admin roles. Return structured
feature decisions containing feature key, scope, limit, revision, expiry and
reason. Resource quotas need atomic reserve/commit/release in the owning app;
a cached boolean check cannot enforce a concurrent quota. Start with feature
flags and simple resource limits, not metered charges. Cache invalidation and
maximum staleness must be explicit and tested. Removing billing cannot silently
turn paid features into public access; already-configured checks fail closed.

The billing admin view covers customer/subscription state, event processing,
entitlement diff, synchronization health and audited recovery. Initial refunds
and complex adjustments use the provider console with reconciliation; do not
build an incomplete accounting ledger. Billing notifications never block an
access update. Suppress duplicate provider/application receipts by declaring
which sender owns each message type. All spending/refund actions require
separate agent capabilities and review according to operator policy.

## Reliable notifications and durable jobs

Build a shared operator package, provisionally `@jimhoyd/urlcode-notifications`,
with a library, worker CLI, adapter contract and optional admin delivery module.
Its package/repository name is proposed; unlike `urlcode-short`, it is not yet a
user-selected repository name. It works without auth/admin; admin integration
still requires auth. Extract it from the first forms implementation once billing
confirms the contract. Avoid a generic distributed workflow platform.

Reliability has three separate states: persisted intent, provider acceptance and
confirmed delivery (when reported). Provider acceptance is not inbox delivery or
human reading. The transport is at-least-once; no blanket exactly-once promise.

1. **Commit:** the producing app stores its state change and outbox intent in the
   same database transaction. A helper must accept the existing transaction;
   sending to a separate queue after commit is not an atomic substitute.
2. **Relay:** a worker leases committed rows, sends them to the delivery service
   and marks them relayed only after durable acknowledgement. A unique source
   plus event/recipient/channel key deduplicates relay retries. Separate stores
   use this relay/inbox protocol, not cross-database transaction assumptions.
3. **Deliver:** fixed trusted handlers render a pinned template/version/locale,
   validate destinations and send through operator-configured adapters. Persist
   attempt IDs and provider IDs. Apply bounded exponential backoff with jitter,
   rate limits, timeouts, finite retry/expiry and per-source fairness.
4. **Recover:** expired leases can be reclaimed with fencing against stale workers.
   A timeout after provider acceptance is an ambiguous outcome. Reuse provider
   idempotency keys where supported; otherwise expose ambiguity and the chosen
   retry policy, which may duplicate mail. Do not mark it delivered or silently
   discard it. Poison jobs go to a visible dead-letter queue with reasoned replay.
5. **Observe:** process authenticated, deduplicated delivery/bounce/complaint
   callbacks. Show pending/retrying/accepted/delivered/failed/suppressed/unknown
   separately. [SES notifications](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html)
   can themselves be duplicated; event processing must tolerate this.

First adapters: a deterministic local capture sender for tests and a production
email adapter chosen from existing operator infrastructure; signed outbound
webhooks are the second transport. Separate transactional from marketing
preferences. Hard bounces/complaints trigger suppression with an audited policy;
critical account workflows surface non-delivery rather than bypassing suppression.
Pin webhook destination origins, bound response handling, block private-address
SSRF and redirects, and rotate signing keys with overlap. No arbitrary shell,
module import or destination from job payloads.

Store minimal encrypted-at-rest payloads where they contain personal data or
short-lived tokens, with strict access and retention. Do not log message bodies,
password-reset tokens or verification codes. Expired tokens must not be resent;
cancel superseded notices by domain revision. Auth integration must preserve
its existing security semantics and needs dedicated regression review; forms
and billing should not force an immediate auth sender migration.

Expose queue age, retry/dead-letter counts, provider errors, bounce/complaint
rates and worker heartbeat. Alert through an independent operator channel when
the notification transport is down. Define retention and purge for payloads,
metadata and backups. Recovery must not replay old external messages merely
because a backup was restored: default to a paused dispatch state and reconcile
provider IDs/outbox watermarks before an operator resumes it.

Reuse leasing/retry primitives for scheduled publication, but keep publication
and email as distinct job types and queues. Cancellation uses expected revisions;
workers recheck permission/policy and current domain state before irreversible
effects. For external sends already in flight, cancellation is best effort and
must report the race. Email outage cannot starve entitlement reconciliation or
site publication.

## Agent-first contract

Every meaningful UI operation uses the same domain service as the API and CLI.
Publish machine-readable schemas, API descriptions, capability discovery,
`llms.txt`, versioned examples and executable fixtures in each package.

Proposed commands such as `urlcode-cms plan`, `apply`, `publish`, `export`,
`doctor` and `urlcode-support tickets reply` are design targets, not working CLI
commands today. Return structured JSON, stable IDs, error codes, pagination,
revision conflicts and operation IDs. Mutations accept expected revisions and
idempotency keys. Plans show diffs, affected URLs, visibility and outgoing
communications. Applying a stale plan fails rather than overwriting another
editor. Support replies, deletions and publishing require their own explicit
capabilities; an operator may require review before external communication.

Keep core MCP read-only. Each app can supply a separate opt-in write MCP adapter
backed by scoped operator authority; it cannot self-grant from project files.
Agents may draft, classify and suggest. Content/tickets are untrusted data, not
instructions authorizing tool calls. Scope retrieval by the acting principal;
record human/agent attribution and require policy checks again at commit time.
AI providers are optional adapters with explicit data permissions and budgets.
No AI account should be necessary to run or edit the suite.

## UI and admin composition

Use urlcode-ui's tokens, template/view-model contracts, locale handling,
light/dark themes, keyboard patterns, empty states and error conventions.
Build shared table/filter, editor, revision-diff, media-picker and ticket-thread
components there only when more than one application needs them. Tailwind
styles ship compiled; no runtime CDN requirement or second theme system.
Current UI docs distinguish compiled primitive CSS from handwritten kit CSS;
consolidation should be a UI issue, not an assumed completed migration.

Admin should accept explicit trusted module registrations containing stable IDs,
labels, navigation, permissions, screens, actions and health observations.
The application owns business operations; admin owns the console shell and
routing. A proposed `/admin/cms` screen is dispatched within admin's one mount,
not registered as a conflicting nested core extension. Reject module collisions
and incompatible view-model versions. A hidden sidebar item is not authorization.
A CMS-only operator does not acquire identity-admin rights; support staff cannot
impersonate users merely because they can read tickets.

## Implementation backlog: owners, dependencies and acceptance

These are proposed work items, not filed GitHub issues. Search the tracker for
existing work before filing. IDs below are local planning IDs. Priorities refer
to their dependent dogfood milestone, not a requirement to finish every shared
abstraction before launching a public page. Each implementation belongs in its
own repository/PR, with compatibility and executable acceptance evidence.

### SUITE-01 — composition contract and admin modules (P0; admin/auth/apps)

Current admin exports offer no generic application-module registry. Add explicit
operator-installed module descriptors for namespace, navigation, view-model
version, screens, actions, permissions and health. Admin owns `/admin/*`; it
internally dispatches `/admin/cms`, `/admin/forms`, `/admin/short`,
`/admin/billing`, `/admin/support` and blog views. No nested competing core mounts.
An application service exists once and is shared by its CLI/API/admin adapters.
Keep the existing admin → auth dependency; no alternative identity system.

Accept when two real modules coexist, registrations fail atomically on ID/path
collision, direct requests enforce permission even without navigation, writes
require CSRF/fresh auth as appropriate, revoked sessions stop working and shared
services close exactly once. Repeat with all six modules before suite release.
Start with forms and short; richer editor components must not block this contract.
Depends on existing core extensions; no product-specific core imports.

### SUITE-02 — shared scaffolding and machine-readable capability plan (P0 preset; P1 core enhancement)

Core already merges scaffold fragments and refuses collisions. Extend only the
missing pieces: typed dependency/contribution metadata, deterministic ordering,
one owner per shared service, explicit project-content files and preflight
compatibility checks. Scaffold files currently cannot be written inside the
project. A package-specific initializer can create a complete reviewed layout
until a generic contribution contract exists; keep it covered by tests.

Accept with order-independent supported presets, safe normalized paths, no
symlink escape, no partially written project after preflight failure and an
inspectable plan containing mounts, packages, services, environment requirements
and target limitations. Admin without auth fails before writing. Blog's CMS
dependency is resolved once. Generic core machinery never downloads/activates
packages named by untrusted YAML. Publish a tested peer/version matrix rather
than relying on unconstrained latest versions. Depends on SUITE-01 descriptors.

### SUITE-03 — permissions, subjects and entitlement integration (P0 before paid access)

Auth owns principals/sessions and permission checks; applications own resource
ownership; billing owns commercial grants. Specify a narrow host-bound adapter
carrying verified subject ID, permissions, authentication freshness, request ID
and optional billing subject. Do not pass raw credentials into guests or infer
identity from client headers. Standalone operator operations use explicit local
operator authority, not a new browser login implementation.

Accept when cross-account resource IDs fail, a paid member cannot administer
other members, form emails do not auto-link accounts, cancellation is reflected
within the documented entitlement staleness budget, and permission/entitlement
checks apply to CLI/API/MCP/admin equally. Include revoked sessions, impersonation
restrictions and concurrent quota reservations. Required for billing and support;
public file-mode CMS does not wait for it.

### SUITE-04 — durable outbox, inbox and notification recovery (P0 before external notifications)

Implement the notification design above first against forms, then billing and
support. App writes and outbox insertion share one transaction. Provide event
schemas, unique consumer keys, bounded leases, backoff/expiry, dead-letter tools,
provider status and dispatch-paused restore. Separate reliability from rendering.
Do not describe existing best-effort auth hooks or core signals as durable.

Accept fault injection before/after commit, duplicate relay, restart while leased,
provider timeout after acceptance, bounce replay, expired token and poisoned job.
Every acknowledged source event must be either pending, completed or explicitly
failed/suppressed; measure delivery ambiguity rather than hiding it. An email
outage cannot erase a form or undo a billing entitlement. Depends on forms' first
transactional slice; freeze shared API only after a second consumer validates it.

### SUITE-05 — publication artifacts and activation (P0 CMS adapter; P1 core API)

Current `serve` snapshots assets; extension responses default to no-store. CMS
must build only the approved public revision into a complete artifact, then use
a trusted deployment adapter to validate/activate it. Store immutable manifest,
content digest, deployment ID, state and previous release. Explicitly review any
changed route/policy revision; a content job cannot renew its own authority.
The first adapter may stage and restart a public server; do not wait for hot
activation or weaken extension caching. Generic atomic activation/reporting is
a separate core proposal after this adapter demonstrates the need.

Accept a failed render/validation/start leaves the old site available; concurrent
publishes serialize; lost acknowledgement reconciles by release ID; drafts never
appear in public assets/search/feeds; rollback restores a coherent release.
Separate static-public delivery from protected content. Test deep-link routes
alongside extension mounts, excluding `/account`, `/admin`, `/forms`, billing and
support namespaces. Depends on CMS compiler; managed/scheduled publishing also
uses SUITE-04 job primitives.

### SUITE-06 — shared UI and bounded media (P0 app acceptance; incremental UI work)

Add accessible tables/forms/statuses first, then the Markdown editor, media picker
and revision diff, then ticket thread. Register view-model samples and catalogues;
compile the shared kit stylesheet with the agreed Tailwind toolchain while
preserving tokens/overrides. Keep vendor notices and review CSP-safe script use.
Core's 1 MiB extension response bound stays; object-storage uploads are explicit
operator adapters with quarantine, authorization, expiry and size limits.

Accept real rendered screens plus keyboard, light/dark, narrow-screen and error
states. Check labels/focus, escaping, stale form versions, localization fallback
and direct unauthorized requests. Verify upload access before and after publish,
unpublish and deletion; no private assets through public URLs. File-mode CMS and
forms without attachments can ship before the media adapter.

### SUITE-07 — urlcode-short migration and abuse operations (P0 short release)

Apply the agreed rename/release migration above. Replace the demo's bespoke HTTP
wrapper with current extension composition where feasible. Retain core link
semantics, expired/disabled behavior and optimistic writes; add an app-owned
ownership model with recoverable metadata/link creation. Keep anonymous creation
bounded and configurable. Anonymous abuse must not degrade existing redirects.

Accept old-store upgrade, unchanged codes/URLs, expiry/takedown, backup restoration,
account isolation, retry-safe creation and aggregate analytics drop behavior.
Document destination rules, retention and takedown workflow. Analytics is never
required for redirects or used as a billing ledger. Depends on SUITE-01 for the
console; anonymous mode remains independently useful.

### SUITE-08 — release truth and executable composition matrix (P0 every release; core/apps)

Reconcile stale FRAMEWORK.md claims about unpublished siblings and adapter
support against actual released revisions. `src/capabilities.ts` admits generic
extensions on Node/AWS/Vercel, but application storage compatibility is separate.
Update llms resources with executable examples, current package names and explicit
unsupported behavior; do not make this proposal look like shipped syntax.

Run installed tarballs in standalone, auth-only and auth+admin modes, plus
admin-only rejection, removing dependencies, stale pins, duplicate mounts,
missing secrets/adapters, package version mismatch and extension order changes.
Adding/removing billing must not bypass configured entitlements. Core remains
free of app imports. Include one synthetic full journey fixture and regenerate
reference/agent docs whenever implemented contracts change.

### SUITE-09 — billing provider reconciliation (P0 before charging; billing)

Implement verified durable ingress, retry-safe checkout, per-subject serialized
reconciliation, entitlement projection, inspection and dry-run repair. Bind
provider account/environment/version explicitly. Keep local state recoverable
from the provider and never interpret a redirect as proof of payment.

Accept duplicate/out-of-order/missing events, payment failure, cancel-now versus
period-end, refund/dispute policy, provider outage, concurrent quota writes and
restore followed by reconciliation. Require test-mode end-to-end evidence before
an explicitly authorized live-money smoke test. Depends on SUITE-03/04; public
pricing pages can ship earlier without accepting payment.

### SUITE-10 — suite deployment, recovery and feedback (P0 dogfood promotion; apps/operations)

Ship pinned standalone/suite manifests, private durable data directories,
non-root containers, health/readiness, worker lifecycle and versioned migration
plans. Each store has one migration owner; starting two processes cannot run
conflicting migrations. Back up content, metadata, files, keys and the release
manifest coherently. Restore into an isolated host with outbound dispatch paused;
reconcile billing before enabling paid operations and review notifications before
resuming them. A shared host is not permission to read another app's tables.

Accept fresh install, upgrade from the preceding dogfood version, backup restore,
disk-full, process kill, mail/provider outage and rollback according to schema
compatibility. Record latency/error/queue-age baselines, recovery timings and
unresolved defects. Each milestone ships an operator runbook, a rollback
path and the required learning report defined below. Dogfood friction becomes a minimal reproducible upstream issue; retain
business policy in the app rather than forking core.

The genuine core work is SUITE-02's generic contribution support, the optional
SUITE-05 activation API, and SUITE-08 documentation/conformance. Admin modules,
billing, notification durability, domain storage and shared UI belong to their
respective repositories. Do not make core a CMS, queue server or payment engine.

## Instant deployment and production acceptance

“Instant deployable” means a reproducible preset, not a demo labeled production.
Ship a standalone npm launcher, a verified container and a compose example for
each app; also ship a suite preset sharing one explicit host and admin shell.
Generate private operator configuration outside the route project, use durable
volumes and refuse public staff mode without identity/secrets/origin setup.
Health/readiness reports storage, migrations, queue backlog and required adapters.
A minimal public CMS/blog export can deploy as static files; the operational suite
initially targets Node plus patched SQLite and a durable volume. AWS/Vercel
extension contracts alone do not make local SQLite apps serverless-ready.

Before a production tag, require recorded evidence for:

- Fresh tarball/container installation, all supported composition presets,
  non-root operation, bootstrap, HTTPS ingress, graceful shutdown and restart.
- Schema migrations with preflight backup, interrupted migration recovery,
  concurrent-update conflicts, bounded jobs and idempotent replay.
- Complete backup/restore of metadata, Markdown blobs, attachments and keys;
  restore drill on a fresh host with measured recovery time/data loss. A DB-only
  backup is insufficient. Rollback must account for schema compatibility.
- Threat-model and security review of content rendering, previews, uploads,
  object authorization, CSRF, mail ingestion, SSRF and cross-app permissions.
  Automated tests do not substitute for independent review.
- Accessibility/browser/mobile checks, load/soak results with published hardware,
  data sizes and latency/error budgets, disk-full and provider-outage exercises.
- Retention/export/deletion controls, redacted logs and metrics, abuse/takedown
  procedures, staff audit and least-privilege deployment examples.
- Apache-2.0 license/notices, contributor/security policy, protected main,
  reviewed PRs, dependency/SBOM checks, supported-version policy and tag-driven
  publishing with provenance. No dist committed and no new CLA/DCO.

Run each repo's verification and package smoke tests, then suite integration CI.
Use alpha releases until the deployment and recovery gates are demonstrated.
No runtime implementation, deployment or production validation occurred in this
spike; no such readiness is inferred from existing status files.

## Build order for impact: dogfood before breadth

The first customer is our own business. Ship small complete journeys and operate
them before expanding feature breadth. These are ordered delivery milestones,
not calendar estimates; only measured implementation work should set dates.
Public site delivery is the first useful outcome. Reliability work begins with
its first real form, not after support and billing depend on email.

| Order | Deliverable and dependencies | What we use ourselves | Evidence required to advance |
|---|---|---|---|
| 0 | Release baseline and naming: SUITE-08 inventory, `urlcode-short` rename plan/execution, SUITE-01 minimal descriptors, SUITE-10 deployment skeleton | Install an existing auth/admin app from pinned artifacts and inspect health | Package/repo identities verified; admin-only rejected; reproducible dev/staging bootstrap; current capability matrix |
| 1 | CMS file-mode vertical slice; SUITE-05 restart/deploy adapter | Publish our home, product, pricing-intent and contact pages from Markdown | Agent plan/validate/publish; human preview; no draft leakage; failed deploy retains previous site; rollback demonstrated |
| 2 | Forms + first notification slice; SUITE-01 first module and SUITE-04 local/production sender adapter | Capture contact and early-access requests, triage them in admin, receive delivery status | Acknowledged submissions survive restart/email outage; duplicate POST produces one submission; consent/export/delete work; notification failure is visible |
| 3 | `urlcode-short` extension/standalone migration; SUITE-07 and second admin module | Use our own stable short links/QR codes in the site and launch communications | Existing links survive upgrade; ownership/takedown work; anonymous mode is bounded; clean published package installation; redirect availability survives analytics failure |
| 4 | Billing test-mode vertical slice; SUITE-03/04/09 | Exercise one paid offering, self-service portal and entitlement enforcement in our own app | Verified payment grants access, cancellation revokes it per policy; out-of-order/missed webhook repair; no role escalation; provider outage behavior verified |
| 5 | Support web+email inbox; reuse notification worker and auth/admin modules | Handle our own inbound questions and test customer issues | Intake/threading/assignment; private notes stay private; reply retry/ambiguity visible; restore does not resend old replies; customer isolation |
| 6 | Controlled paid dogfood promotion; SUITE-10 recovery/security/operations gates | Operate the complete site → lead → account → checkout → entitled action → support journey | Authorized live-provider checks, restore drill, least-privilege review and operational monitoring; no critical unresolved journey defect; free path still useful |
| 7 | Managed CMS editing + blog on CMS + support knowledge base | Publish release notes and tutorials; edit pages in admin; link help articles in support | Concurrent edit conflicts; revision diff/review/restore; scheduling survives restart; RSS/sitemap/search agree on published revision |
| 8 | Production suite release and broader onboarding | A fresh operator installs an individual app or the full suite without our assistance | Whole-suite journey and failure matrix, composition/upgrade/package tests, learning reports, deployment/accessibility/security/recovery evidence and published compatibility policy |

Why this sequence: CMS establishes the public surface; forms captures demand;
short reuses an existing implementation and proves a second independent admin
module; billing tests the revenue path; support is ready before paid promotion.
Managed editing/blog follow once acquisition and customer service work. Do not
wait for a visual page builder, a CRM or every content workflow to dogfood.
Phases 1–5 can be internal alphas; they are not declarations of production safety.
If short migration expands substantially, preserve existing redirect service and
move optional analytics after the first billing/support journey.

A practical dependency map:

```text
core + ui + auth -> admin -> app management modules
core + ui -> cms file mode -> public site
forms -> durable outbox -> notifications -> billing notices / support replies
core LinkStore -> short (auth/admin optional)
auth subject adapter + billing reconciliation -> enforced paid features
cms + durable publication jobs -> blog and optional support knowledge base
all app artifacts + recovery evidence -> suite production release
```

Notification delivery is not a prerequisite for entitlement decisions, redirect
resolution or serving published pages. Public CMS/short/forms remain useful
without auth/admin; private customer features never silently degrade to public.
Blog requires CMS, support does not. Paid app access may require auth even though
the standalone billing service can manage operator-bound customer subjects.

### Dogfood acceptance and feedback loop

Keep synthetic fixtures in public repositories; production contacts, messages,
receipts, keys and business-specific configuration stay in operator storage.
Do not commit dogfood data to reproduce a defect. Record each milestone's exact
package versions, app revision, image digest, deploy target and known limits.

| Journey | Human and agent checks | Operational measure |
|---|---|---|
| Author → publish → rollback | UI/CLI report the same content revision; stale plans fail | Time to publish, failed activations, rollback time |
| Visitor → form → follow-up | Same receipt on retry; staff export/reply scopes enforced | Accepted submissions, oldest unprocessed lead, queue age, terminal delivery failures |
| Short link → redirect → takedown | Anonymous/account paths obey limits; disabled link no longer resolves | Redirect latency/errors, blocked creation, takedown completion time |
| Checkout → paid action → cancellation | No access from success URL alone; API/UI decisions agree | Webhook lag, reconciliation mismatches, time to grant/revoke |
| Ticket → staff reply → customer response | Private notes never leave staff scope; duplicates don't create a second ticket | Oldest unanswered ticket, failed sends, response time |
| Restart/restore → resume | Outbound dispatch paused, provider state reconciled, old content available | Measured restore time/data loss and replay/duplication incidents |

Proposed initial internal targets, to measure and revise rather than advertise
as an SLA: reconcile acknowledged billing events within 60 seconds under normal
load; alert on notification queue age over five minutes; perform a fresh-host
restore before every milestone that introduces a new persistent store. Validate
bounds with the actual sender/provider and record exceptions. Zero tolerated
acceptance failures for acknowledged-data loss, unauthorized access, draft/private
note leakage, or double effects from locally duplicated requests/events. External
provider send ambiguity is a separately measured limitation, not proof of
exactly-once mail. Independent alerts must work when email is unavailable.

At each milestone, record friction with steps, expected/actual behavior, scope,
workaround and owner. Classify it as application UX, shared UI, admin composition,
core contract, provider operation or documentation. Fix only the smallest shared
contract needed by a real consumer; exercise it in a second consumer before
calling it stable. Convert the reproducible records into linked implementation
issues/PRs and close them only with evidence, not just documentation edits.

## Required learning and modular extraction at every milestone

Dogfooding must improve the framework as well as the applications. Each milestone
ships a short learning report alongside its acceptance evidence, even when the
conclusion is that no core change is needed. Record:

- The real human/agent task, package revisions and a synthetic reproduction.
- What core and existing modules supplied, what the app had to duplicate, and
  where contracts or documentation caused friction.
- Measured cost where available: setup steps, failed attempts, latency, recovery
  time or duplicated behavior. Do not invent productivity percentages.
- Proposed owner: app, shared module, admin, UI, core, documentation or operations;
  alternatives considered and why the smallest proposed change belongs there.
- A linked issue/PR, regression fixture, compatibility impact and outcome; retain
  unresolved findings with an owner and the next milestone that needs them.

Public reports contain sanitized evidence only. Business-specific policy and
customer data stay outside public repositories. Before the next milestone,
review unresolved findings, implement blockers, and assign useful non-blocking
improvements rather than letting them disappear into a retrospective.

### Principles remain acceptance constraints

A core improvement must preserve declarative portable route behavior, external
operator configuration, explicit capabilities and revision-pinned grants, WASM
isolation for untrusted application code, strict validation and target refusal,
and a useful free/self-hosted runtime. Core must not import suite applications,
auto-load privileged project modules, execute guests in Node, move provider
settings into route YAML, or weaken authorization/caching boundaries to make a
particular app easier. Keep domain state and business workflows outside core.

Every proposed core change includes a principles-impact note and executable
conformance evidence, with a small non-suite consumer or fixture demonstrating
that the contract is generic. If the problem is only app policy, fix the app.
If a shared library solves it without a runtime change, prefer that boundary.
Generic runtime improvements must land upstream through reviewed PRs; do not
maintain a private behavior fork just to make the dogfood deployment work.

### Extract common behavior into modules, following urlcode-ui

Treat urlcode-ui as the model: a focused, versioned package with a clear contract
consumed by independent applications. Start with a concrete implementation,
identify a second real consumer, compare their semantics, then extract the
smallest shared behavior. Avoid both copy-and-paste implementations and a
speculative all-purpose framework. Planned shared infrastructure may start with
one consumer, but must prove a second before its public contract is stabilized.

| Candidate | Evidence to seek | Intended boundary |
|---|---|---|
| Tables, forms, theme, locale, safe view rendering | Same interaction in two app screens | urlcode-ui; app-specific screens stay in their apps |
| Admin registration/navigation | Two independent apps in the same console | urlcode-admin; domain mutations stay in app services |
| Outbox, inbox, delivery, leasing | Forms plus billing/support need the same delivery guarantees | Shared operator package; no arbitrary guest job execution |
| Media validation/storage | CMS and support need compatible upload/security behavior | Narrow storage/media adapter; public and private access rules remain explicit |
| Publication and content revisions | CMS, blog and help articles share content semantics | CMS exports; blog/support consume rather than fork the engine |
| Permission/entitlement decisions | Multiple services require the same verified decision shape | Auth/billing adapters; apps retain resource ownership and business policy |
| Activation/scaffold primitives | Independent consumers hit the same runtime limitation | Generic core API only when the host/runtime must enforce it |

Each extraction needs an owner, versioned public exports, narrow dependencies,
contract tests, migration notes and clean tarball installation in both consumers.
Move consumers onto the shared implementation and remove superseded copies;
verify behavior before/after, including failures and authorization. Reject cyclic
dependencies and a catch-all utilities package. Avoid a shared database schema
that lets one module silently mutate another module's state. Keep apps usable
standalone with explicit adapters and without requiring the whole suite.

## Whole-suite testing is a release gate

Passing each repository's tests is necessary but insufficient. Build the suite
harness incrementally from the first two integrated apps and run the complete
suite before final release. The final gate covers core, UI, auth, admin, CMS,
blog, short, forms, billing and notification workers plus support in one pinned,
production-shaped deployment. It must not rely on unpublished sibling source
imports or developer symlinks to pass.

Maintain a versioned integration harness and suite manifest under a named release
owner. Its eventual repository location is a delivery choice, not a new core
application dependency. Install candidate tarballs/container images into a clean
environment; record exact digests, test results and supported combinations.
Use deterministic fake providers for CI, then separate provider test-mode and
explicitly authorized live deployment checks. Fakes are not delivery evidence.

The required end-to-end journey is:

1. An agent drafts a page and post; an authorized publisher previews and publishes
   them. Drafts remain private; public pages, feed, sitemap and search agree.
2. A visitor follows a short link to the site and submits a form. The submission
   is durable, appears in admin, and produces a traceable notification intent.
3. A verified customer signs in, completes test checkout and gains only the paid
   feature entitlement. A second account cannot access their resources.
4. The customer opens a ticket; staff triages it, adds a private note and replies
   with a published knowledge-base link. Only the public reply reaches them.
5. Cancellation or payment failure changes access according to policy while
   preserving account, support and export access. Session revocation takes effect.
6. Upgrade and restore the entire deployment, reconcile billing and resume workers
   deliberately. Published content and short URLs survive; private data stays
   private and acknowledged work is accounted for without blind resend.

Run the following system-level matrices in addition to this happy path:

| Area | Required evidence |
|---|---|
| Optional modules | Each app standalone, auth-only and auth+admin; admin-only rejection; blog without CMS rejection; support without CMS; safe removal of optional modules |
| Shared host | Mount/service collisions, dependency ordering, migration ownership, startup rollback, one-time close, shared UI/CSP/cookies and authorization isolation |
| Cross-app writes | Duplicate requests/events, concurrent edits, stale revisions, permission revocation and quota races across CLI/API/MCP/UI |
| Partial failures | Restart during publish/send/webhook processing, disk-full, exhausted worker pools, provider outage, dead-letter replay and bounded backpressure |
| Isolation | A notification backlog cannot stop redirects/public pages; one app's failure cannot grant access or expose another app's data; resource limits hold under contention |
| Upgrades | Previous supported suite to candidate, permitted mixed versions, incompatible-version refusal, interrupted migrations and documented rollback limits |
| Recovery | Coherent backup of every store/blob/key/release; clean-host restore with dispatch paused; reconciliation and measured recovery time/data loss |
| Human experience | Navigation across all apps, shared theme/locale, responsive layouts, keyboard/accessibility checks and coherent error/recovery paths |

Every shared-contract PR runs affected consumer integration tests before merge;
release candidates run the full matrix and soak/recovery exercises. The suite
manifest cannot promote incompatible artifacts merely because their independent
CI passed. Release evidence names what ran, what failed, what remains unverified
and the accountable owner. Critical security, data-loss or broken customer-journey
failures block promotion. CI success remains distinct from independent security
review and real-provider operational proof.

## Remaining expansion after the launch suite

Forms, billing and reliable notifications are now in the launch plan, not
optional future suggestions. The remaining candidates are:

| Priority | Addition | Boundary |
|---|---|---|
| Later | `urlcode-crm` | Contacts, companies and a small pipeline; evolve forms' lead handoff without duplicating auth identities |
| Later | `urlcode-analytics` | Privacy-conscious aggregate site/product events; no payment ledger based on lossy telemetry |
| Later | `urlcode-status` | Service status and incidents; reuse publishing and notification channels |
| Segment-dependent | Commerce, booking, newsletter automation | Integrate established payment/calendar/email infrastructure after a specific customer need |

A full enterprise ERP, accounting ledger, tax system, omnichannel contact center
or autonomous outbound sales agent is outside this launch scope. The first suite
must complete and operate the site → lead → customer → payment → support journey.
