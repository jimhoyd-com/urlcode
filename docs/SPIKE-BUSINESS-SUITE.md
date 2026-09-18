# URLCode business suite spike

Date: 2026-09-18. Status: proposal, not an implemented contract or production claim.
Core inspected at `50790d3` (0.4.0-alpha.1), plus local auth, admin, UI and
shortener source/status files. Competitor research below is a documentation
review, not hands-on benchmarking. Features and commercial packaging can change.

## Recommendation

Build four independently released Apache-2.0 applications on URLCode:
`urlcode-cms`, `urlcode-blog`, `urlcode-shortener` and `urlcode-support`.
Use `@jimhoyd/urlcode-<name>` packages. Preserve the existing `urlcode-shortener`
repository spelling rather than creating `urlcode-shortner` alongside it.
Each application has one domain service, an operator-installed runtime extension,
a CLI/API for agents, and a standalone launcher composing the same components.
Standalone means no separate URLCode installation/configuration exercise; it
still uses URLCode internally. Auth and admin are optional integrations.

CMS is the content foundation; blog is a CMS preset plus publishing features.
Support reuses CMS for its optional knowledge base, not for ticket storage.
Shortener reuses core's live-link engine. Core remains generic and never imports
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
| Neither auth nor admin | CMS/blog serve public content; CLI/local agent manages it. Shortener can run its bounded anonymous mode. Support exposes intake and public help only; staff work uses operator CLI/API. No public management console |
| Auth only | Account identity, scoped application APIs and optional restricted content/customer ticket portal. No duplicate account system; CLI/API remain full management surfaces |
| Admin only | Unsupported: admin requires auth. Initialization and activation reject this combination with an actionable error |
| Auth and admin | Integrated, permission-filtered management screens and shared accounts; domain services enforce every operation regardless of UI visibility |

**Confirmed product rule:** admin requires auth, matching its current required
peer and privileged service. Keep that dependency. Removing auth while admin is
configured must refuse activation. Protected content, private tickets and writes
also fail closed; removing admin alone should only remove the console.

For a complete standalone console, provide a recommended preset composing auth,
admin and the application. Also retain a minimal preset with neither. Do not
implement four independent password/session systems.

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
| Shortener | Existing anonymous short-lived mode; authenticated ownership and CRUD; custom slug; expiration/disable; QR; tags; CSV import/export; bounded aggregate analytics; operator takedown and abuse reporting | Verified custom domains, campaigns, richer analytics; no affiliate product initially |
| Support | Email and web intake; ticket thread/status/priority; assignee/team queues; public replies vs private notes; safe attachments; search; macros; customer-scoped portal with auth; audit; delivery retries; basic response/resolution timing; optional CMS help center | Business-hours SLA calendars/escalation, automation rules, CSAT, chat and additional channels |

CMS localization-ready IDs/schema ship first; do not claim translated UI or
content until catalogues and workflows are tested. Scheduling requires durable
worker execution, restart catch-up and cancellation/version checks; it is not
an in-process timer. CMS does not need to block its first release on scheduling,
but the listed blog scope does.

Shortener migration: the existing demo is private/unpublished and marked
UNLICENSED, pins an old core archive, and has no auth/analytics. This proposal
records the requested direction to Apache-2.0 and public packages, but the
implementation PR must verify rights to existing assets/dependencies, add the
license/notices, migrate the package/runtime pin and preserve existing links,
expiry and QR behavior. Evolve the existing repo. Reuse core's LinkStore and
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

## Core and sibling issue backlog

These are issue-ready proposals, not filed GitHub issues. Confirm duplicates
against the remote tracker before filing. P0 means composition/release blocker;
P1 means a useful follow-up with a supported initial workaround.

| Priority / owner | Proposed issue and evidence | Acceptance |
|---|---|---|
| P0 core docs | Reconcile FRAMEWORK.md with current packages and target support. It says extensions are unpublished and adapters refuse them; local sibling status reports npm alphas and `src/capabilities.ts` admits registered extensions on Node/AWS/Vercel | Version/commit-backed release matrix; generic adapter support separated from each application's supported storage/target; synchronized agent docs |
| P0 composition tests | Preserve the admin → auth dependency across every application preset | Admin-only initialization/activation fails clearly; removing auth fails closed; removing admin preserves authenticated app APIs |
| P0 admin | Add trusted application module registration; public exports have no generic app-module registry | CMS/blog/links/support screens coexist under one mount; collision, permission, CSRF, session revocation and lifecycle tests |
| P0 apps + core tests | Executable composition conformance suite using the existing extension API | Test the three supported modes plus rejection of admin-only, both removal cases, missing adapters, stale pins, duplicate mounts, initialization in different extension orders and package installation from archives |
| P1 core | Generic immutable artifact activation/reporting for managed publishing; production serve currently snapshots assets | Validate complete candidate before switch; in-flight isolation; failure retains old artifact; release-ID reconciliation and rollback; no implicit execution-grant renewal. Initial workaround: deploy/restart public artifact |
| P1 core CLI | Extend scaffold composition for shared services and app contributions. Current fragments reject duplicate keys and files cannot be placed inside app by extension scaffolds | Deterministic dependency ordering, shared service deduplication, explicit collision diagnostics, safe project-content contributions, no partial output on failure; no automatic package execution from YAML |
| P1 core docs/tests | Document extension payload/media constraints and storage ownership | Examples prove 1 MiB response boundary and safe external media flow; do not remove bounded response/header safeguards |
| P1 auth/shared operator library | Versioned identity/permission adapter and durable event delivery contract; auth lifecycle notices are currently best effort | Principal, scope, fresh-auth and revocation semantics; durable outbox with retry/dead-letter handling; explicitly documented transaction boundaries |
| P1 UI | Shared app components and consistent Tailwind build for kit/primitives | All application sample views render; keyboard/light/dark/mobile checks; CSP-safe scripts; preserved overrides and translations |
| P1 shortener/core docs | Refresh earlier shortener composition findings against current extensions | Replace bespoke HTTP wrapper with standard extension mount where feasible; regression tests retain redirect/expiry behavior and HTTP bounds |

Do not put CMS schemas, ticket tables, mail providers, a generic ORM, billing or
an unrestricted job executor into core. Start a shared jobs/storage/operator
library only where multiple apps demonstrate the same contract. Existing mounts,
revision pins, scaffold hooks and immutable-asset support already solve parts of
the problem; do not propose replacing them wholesale. Dynamic public caching is
not required for the initial static publishing path.

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

## Build sequence and broader business gaps

1. Resolve admin modules, preserve its auth dependency, agree service boundaries and add composition
   fixtures. Update stale framework claims in a focused follow-up PR.
2. Deliver file-mode CMS end-to-end and migrate shortener to the current extension
   pattern. These prove content publishing and a transactional application.
3. Add managed CMS editing, then blog as a CMS consumer. Validate artifact recovery
   and durable scheduling before advertising scheduled publishing.
4. Build support around reliable web/email tickets and delivery recovery. Add
   CMS knowledge base and account portal as optional integrations.
5. Release the integrated suite preset only after cross-app deployment/restore,
   permission, accessibility and upgrade checks pass.

The largest gaps in “launch an entire business” are collecting leads, getting
paid and reliably communicating with customers. Suggested next applications,
ranked by reuse and launch value (design recommendations, not market research):

| Priority | Addition | Boundary |
|---|---|---|
| 1 | `urlcode-forms` | Contact/lead forms, validation, spam protection, consent and webhooks; works with CMS and support |
| 1 | `urlcode-billing` | Provider checkout/subscriptions and app entitlements; verified/idempotent webhook processing; no home-grown card storage or tax engine |
| 1 | Shared notifications/jobs | Transactional email/templates, retry/delivery visibility and signed webhooks; library/worker before another dashboard product |
| 2 | `urlcode-crm` | Contacts, companies and a small pipeline; separate customer records from login identities |
| 2 | `urlcode-analytics` | Privacy-conscious aggregate product/site events; shared with shortener and blog; no billing dependency on lossy telemetry |
| 2 | `urlcode-status` | Service status and incident updates; reuse CMS publication and notification channels |
| 3 | Commerce, booking, newsletter automation | Add only for a chosen business segment; integrate established payment/calendar/email infrastructure |

A full enterprise ERP, accounting ledger, tax system, omnichannel contact center
or autonomous outbound sales agent is outside this launch scope. A cohesive
site → lead → customer → payment → support path is a stronger first suite.
