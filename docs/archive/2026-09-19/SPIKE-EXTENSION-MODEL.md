# Historical record

Archived 2026-09-19. This records an earlier implementation or proposal, not
current instructions. See the [current roadmap](../../../ROADMAP.md),
[current contract](../../SPECIFICATION.md) and [open decisions](../../OPEN-DECISIONS.md).
Remaining acceptance work is not declared complete by archiving this record.

<!-- trust-model-prose: historical-file -->
<!-- guidance-claims: ignore-file -->

# Review: the extension model, its precedents and its alignment

Status: review of the [auth](https://github.com/jimhoyd-com/urlcode-auth/blob/main/docs/SPIKE-AUTH.md), [admin](https://github.com/jimhoyd-com/urlcode-admin/blob/main/docs/SPIKE-ADMIN.md) and
[UI kit](https://github.com/jimhoyd-com/urlcode-ui/blob/main/docs/SPIKE-UI.md) spikes against the runtime's principles and against
how established frameworks add the same capabilities. Core portability is
the fixed point: a project's YAML must work unchanged on another host.
Section 1 is what the review changed; section 2 is what other projects do
and what was taken from each; section 3 is the case for the model.

## 1. Alignment issues found and how they were resolved

1. **A YAML-only project has no server file.** The spikes said `init`
   writes "a plugin line into the server file", but projects run through
   `urlcode dev` and `urlcode serve`; the starter is YAML, functions and a
   Makefile. Operator material already loads from explicit paths
   (`--policy`, `--compliance-rules`, `--auth-file`), never from inside the
   project. Resolved: a host file, `host.js`, exporting `{ store, plugins }`,
   loaded with `--host-file <path>` and written by `init`; the starter's
   `make dev` and `make serve` pass it. It is the one file of code an
   extended project has, it is operator code by the same rule as the grant
   file, and it is never discovered by convention inside the project
   because the project is untrusted content.
2. **`origin` in `auth.yaml` broke portability.** The passkey relying-party
   id and provider redirect base were in the auth block. An origin is a
   deployment fact; the runtime already takes `--origin` for the sitemap
   and compliance. Resolved: removed from YAML, taken from `--origin`.
3. **`mount` duplicated the route.** The auth block carried `mount:
   /account` while the route `/account/*: { extension: auth }` already
   said where the extension lives. Resolved: the route is the mount.
4. **Two ways to protect a route.** `protect` path patterns in `auth.yaml`
   and `policies.auth` on routes would drift apart. Policies already have
   profiles for sharing a requirement across routes. Resolved: `protect`
   removed; `policies.auth` on a route or in a profile is the only way.
5. **`extensions.ui` had no owner.** The runtime seam refuses a block no
   plugin claims, and the kit was described as a library. Resolved: the kit
   ships one small plugin that owns the block and serves the stylesheet and
   scripts at one route, which also answers how two extensions avoid
   serving the same asset twice.
6. **Extension routes had no fixtures.** The audit generates fixtures for
   native routes from their declarations; it cannot for an extension route.
   Resolved: the plugin supplies fixtures for its routes through the
   existing `testPlan` seam, so the audit, `urlcode test` and
   `verify-deployment` cover them.
7. **Translations were "later".** Every string in the kit and the notices
   is catalogued from the first release, with language negotiation, plural
   rules, locale formatting and RTL-safe templates; English ships, any
   language is a file. Adding this later would have meant re-touching every
   template.
8. **`__Host-` cookies in development.** The prefix requires `Secure`;
   browsers treat `http://localhost` as a secure context so it works there,
   but not on a LAN address. `urlcode dev` uses a `__Host-` cookie on
   localhost and a plain-named one elsewhere, and `hardened` refuses
   anything but `__Host-` in production. Noted in the auth spike.

What did not need changing: the four runtime seams stay generic; the
store contract stays a document store with declared indexes and no joins;
the plugin remains the only host-code seam; nothing in YAML names a
package; every target either enforces or refuses at activation; the
runtime never depends on an extension.

## 2. How other frameworks do this, and what was taken

The pattern "core stays small, capabilities arrive as installable pieces
that bring routes, storage, pages and configuration, and the app overrides
them by file" is thirty years old. The instructive precedents:

| Framework | The piece | Adds routes | Adds storage | Pages and override | Configuration | Taken |
|---|---|---|---|---|---|---|
| **Django** | `contrib.auth`, `contrib.admin`, `django-allauth` | `include()` in `urls.py` | models plus migrations | template override by path (`templates/account/login.html` shadows the app's); admin registered per model | `settings.py` keys per app | The include model, per-path template shadowing, auth and admin as two apps where admin builds on auth |
| **Rails** | engines: Devise, ActiveAdmin | `devise_for` route helper, `mount Engine => "/admin"` | migrations generated into the app | `rails generate devise:views` copies views into the app to edit (ejecting); copy in `config/locales/devise.en.yml` | initializer file | Eject as the override mechanism; copy in a locale YAML file with ids, the origin of the copy catalogue |
| **Laravel** | Fortify (headless auth) plus Breeze or Jetstream (UI), Filament (admin) | service provider registers routes | migrations published | `php artisan vendor:publish` copies views, config and translations into the app; Filament resources per model | published config file | The split between a headless behaviour package and a UI package, which is the auth versus UI kit split; publish equals eject |
| **WordPress** | plugins and themes | plugins register rewrite rules | plugin tables | template hierarchy and child themes: the app's file wins over the plugin's | options table, filters | The override order "project file, then extension default, then kit default", and the lesson that logic in templates is where plugin ecosystems rot |
| **Keycloak** | realms, themes | its own server | its own database | theme directories override templates, CSS and messages per realm | realm JSON | Message bundles per theme; the account console's surface |
| **Ory Kratos** | identity schemas, self-service flows | its own server | its own database | no UI, flow JSON for any renderer; Elements as optional components | identity schema JSON | Flows as resumable records with ids; identifiers, traits and credentials modelled apart |
| **Better Auth** | server plugins with a client counterpart | plugin declares endpoints | plugin declares schema, CLI generates migrations | no UI | TypeScript config | An extension declares its routes and collections and the tooling derives the rest; hooks for the app |
| **Supabase Auth**, Auth.js, Lucia | libraries or a service | fixed endpoints | fixed schema | none | config object | Mostly what to avoid: UI is always the app's job, so every app rebuilds the same pages |
| **Payload CMS**, Strapi | plugins that inject into the admin | yes | collections | admin injection points | config | Admin as an extension that other extensions can add sections to, reserved for later |

Two observations from the table shape the model:

- **Every mature framework ended up with the same four things**: a way to
  include routes, a way to add storage with migrations, a way to override
  pages by file, and a configuration surface per piece. The runtime's four
  seams are those four things, named for this runtime.
- **The frameworks that ship a UI with the capability (Django admin,
  Devise views, Breeze, Filament, Keycloak) are the ones people reach for
  first**, and the ones that leave UI to the app (Kratos, Supabase, Auth.js)
  are the ones where every project rebuilds the same sign-in page. The kit
  and the accounts page are the difference.

Where this model departs from all of them, deliberately: the
configuration is YAML validated by a schema rather than code, so a project
is data that can be checked, diffed, audited and moved; the extension
brings no framework of its own to the browser; and the trust boundary
between the project (untrusted) and the operator (host code) is explicit,
which none of the precedents have because they assume the app author and
the operator are the same person.

## 3. Does this let a builder, human or AI, build less?

Yes, with conditions. The claim is not that a framework makes building
faster in general; it is that this shape removes the specific work that is
both repetitive and dangerous to get wrong.

What it removes:

- **Auth, accounts and admin are the parts every product needs and the
  parts most often built badly.** Password storage, session fixation,
  enumeration, CSRF, open redirects, recovery abuse: an AI writing these
  from scratch reproduces the average of what it has read, and the average
  is not good. A declared method with the decisions already made is safer
  than a well-prompted rewrite.
- **Declaration is a smaller target than code.** A schema-validated YAML
  key has a few valid values; a hand-written sign-in flow has unbounded
  ways to be subtly wrong. Generation against a schema, with `validate`,
  `audit` and `test` as the loop, is where an AI is reliable. The runtime
  already leans this way (`llms.txt`, the YAML reference, executable
  examples with fixtures).
- **Overrides by file, not by fork.** Restyling by theme variables and
  ejecting one template is work an AI does well and cannot break the flow
  with, because the template cannot change behaviour.
- **Portability means the work survives the next decision.** A project
  that moves from a laptop to a server to a Worker keeps its YAML; the
  builder does not redo the product to change hosts.

The conditions, without which the claim fails:

- **Coverage.** The extensions must cover what a typical product needs;
  if the first thing a builder wants is missing, they are back to building.
  The scope cut in the auth spike is a bet that passwords, passkeys, email
  codes, roles, an accounts page and an admin cover the first ten
  products. That bet should be checked against the first three real ones.
- **The escape hatch must be as easy as the declaration.** The twenty
  percent that is product-specific goes into functions in the WASM guest
  with granted bindings. If that path is harder than declaring, builders
  will route around the runtime.
- **Documentation written for a reader with no history.** An AI has read
  a great deal of Django and Rails and nothing of this runtime. The
  schema, the reference, the cookbook and `llms.txt` are the training
  data; every extension needs the same set on day one, and `init` must
  print what it did in words a first-time reader can follow.
- **Small surface, stable contracts.** The advantage disappears if the
  YAML keys churn. View-model versioning, the seam contracts and the store
  contract are the promises; they should change rarely and loudly.

The honest comparison is not "this framework versus writing it by hand".
It is "this framework versus Clerk, Supabase or Firebase", which also let
a builder skip auth. Those win on time to first sign-in today and lose on
portability, on cost at scale, on data ownership and on running offline or
on a Worker. This model's claim to be better for a builder is that it
offers the same skip with the YAML, the data and the pages staying theirs.
That is a real position, and it holds only while the runtime stays as
portable as it is now.

## 4. Against Clerk

Clerk is the product a developer reaches for when they want auth, an
accounts page and organizations without building any of it, so it is the
right yardstick. Feature by feature, with Clerk as of 2026:

| Clerk has | This model, first release | Gap |
|---|---|---|
| Prebuilt sign-in, sign-up, user profile, user button components (React, Next.js, Expo, iOS, Android) | Server-rendered pages on the kit, restyled by theme and ejected templates; no component library | Drop-in React components. Cut for now; a `urlcode-ui/react` package is the answer if React apps are the audience |
| Hosted account portal | Self-hosted accounts page at `/account` | None: self-hosted is the point |
| Passwords, passkeys, email code, magic link, SMS code, 20+ social providers, Web3 wallets | Passwords, passkeys, email code, Google, Apple, plus any OpenID Connect provider by issuer URL (added below) | Named buttons and icons for the long tail of providers; SMS; Web3 |
| MFA: TOTP, SMS, backup codes | TOTP, passkey, recovery codes | SMS as a factor (deliberately) |
| Multi-session: several accounts signed in, switch between them | One session per browser | Account switching. Small to add later; the session model allows it |
| Organizations: roles, permissions, invitations, domain auto-join, switcher, B2B SSO (SAML, OIDC), SCIM | Column reserved; nothing else | The largest gap, and Clerk's moat for B2B. Planned, not first release |
| Bot protection (Turnstile built in), disposable-email blocking, email and domain allowlist and blocklist, sign-up restrictions, waitlist mode | `challenge` hook, honeypot, velocity limits; allowlist, blocklist, disposable list and waitlist added below | A shipped Turnstile adapter, added below |
| User metadata: public, private, unsafe per user | Added below as `metadata` on the account with the same three visibilities | |
| Impersonation, dashboard with analytics, user management UI | Admin extension: dashboard and full user management | Same shape, ships one release later |
| Webhooks (Svix) for every event | Observability events and host hooks | A webhook sender with signing and retries; added to the later list |
| JWT templates and integrations (Supabase, Hasura, Convex) | Sessions are opaque; no token issuance | Issuing tokens for third-party services comes with "being a provider", later |
| Email and SMS template editor in the dashboard | Templates as files in the copy catalogue, previewable with `preview` | An editor. Files are the deliberate choice: reviewable, portable |
| Localization: many languages shipped | Mechanism day one; English shipped | Translated catalogues. Community and native review needed |
| Theming: appearance prop, CSS variables, themes | Theme variables, ejected templates, own stylesheet | None |
| Testing tokens, test mode | Test mode with deterministic codes and a fake identity provider | None |
| SOC 2 Type II, HIPAA BAA, GDPR DPA as the vendor's paper | Compliance evidence export, audit log, retention, a security review before 1.0 | The paper itself. A self-hosted product cannot hand over a vendor's certification; it hands over the evidence for the operator's own |
| Managed infrastructure, uptime, free tier to 10,000 monthly users, then per-user pricing | Runs on the operator's host; no per-user cost; no one to page | The absence of a vendor is both the gap and the reason |

Added to the first release from this comparison, because each is small
and each is something a builder would notice missing on day one:

- **Any OpenID Connect provider** by issuer URL and client id, with
  discovery, beside the named Google and Apple: `oidc: { okta: { issuer:
  … } }`. Named providers are sugar over this.
- **Account `metadata`** with `public`, `private` and `unsafe` scopes:
  public is readable by the guest binding and the accounts page, private
  only by the host and admin, unsafe writable by the user. Declared
  fields with types in YAML, so it is still a schema.
- **Sign-up controls**: `registration: open | invite-only | waitlist |
  off`, with an allowlist and blocklist of emails and domains and the
  bundled disposable-domain list.
- **A Turnstile adapter** for the `challenge` hook (and the hook stays
  vendor-neutral; hCaptcha and reCAPTCHA adapters are a few lines each).

Moved onto the later list: multi-session account switching, a signed
webhook sender with retries, token issuance for third-party services, and
the React component package.

### Will it be the obvious choice?

Not for everyone, and it should not try to be. It becomes the obvious
choice for a specific developer, and that developer is common:

- Someone who wants to own the data and the pages, run on their own host
  or a Worker, and never pay per user. Clerk's pricing and hosted portal
  are the reasons people leave it at scale.
- Someone building with an AI, or as a small team, who wants the whole
  product declared and checked rather than assembled from SDK calls. The
  YAML, the audit and the fixtures are the pitch; Clerk has no equivalent
  of "diff this pull request's route and policy changes".
- Someone in a regulated or data-residency context who needs the
  evidence, not a vendor's certificate.
- Someone whose site started as redirects and pages and is adding
  accounts, which is exactly the runtime's on-ramp.

It is not the obvious choice, today, for a React or Next.js team that
wants drop-in components and organizations with SAML this quarter, or for
a team that wants a vendor to hold the compliance paper. Both are
reachable: organizations and SSO are the planned second phase, and the
React package is a cut, not a rejection.

What decides it in practice is not the feature table. It is whether a
developer gets from `npm install` to a working, good-looking sign-in with
passkeys in under five minutes, whether the docs answer the next question
before it is asked, and whether the first three real products fit the
scope. Those three are the work.

## 5. Stepping back: is this still one system, and do the extensions make sense?

With auth, admin, the kit and the candidates after them, the runtime stops
being "a portable URL runtime" and becomes a declarative web application
platform: a small kernel and a set of installable capabilities. That is a
change of identity and it should be said out loud rather than drift. The
question is whether the extension shape is the right way to become that,
against the two alternatives.

- **Everything in core**, the Django `contrib` way. Fastest to build and
  the most coherent to document, but every site would carry auth code it
  does not use, the Cloudflare closure would grow, and the runtime's
  promise that a redirect-only project is tiny and portable would erode.
  Rejected.
- **Separate services**, the Keycloak way: auth as its own server the
  site talks to. Cleanest isolation, but a second process to run, a
  second store, and the accounts page lives somewhere else. It is what
  people leave Keycloak to avoid. Rejected.
- **Extensions on generic seams**, the Rails engine and Laravel package
  way. Core stays a kernel; a capability is a package that brings routes,
  collections, pages and a YAML block; the operator installs it. This is
  what every long-lived framework converged on, and it is the shape the
  spikes take.

So yes, the extensions make sense, on four conditions that the review
adds to the plan:

1. **Name the whole.** The runtime is the kernel; the kit and the
   extensions are the distribution. The README should say "a portable
   runtime for sites and the accounts, admin and forms they grow into",
   and the roadmap should show the path in section 1 of the kit spike.
   The principles do not change; the pitch does.
2. **Keep customisation in the untrusted tier.** Extensions are trusted
   host code; a project's own logic is untrusted WASM. <!-- trust-model-prose: historical -->
   A builder who wants a custom rule in a flow ("only `@acme.com` may register",
   "after sign-up, create a workspace") must not have to write host
   code. Extension lifecycle hooks should be able to call a project
   function in the guest, through a granted binding, with a typed input
   and output. Customisation then stays portable YAML plus a guest
   function, and the host file stays what `init` wrote.
3. **The store needs aggregates.** A document store with equality
   lookups serves auth, but the admin dashboard and every product feature
   want counts and time buckets. Add `count(where)` and a bucketed count
   by a declared timestamp index to the contract now, so no extension is
   tempted to open the backend directly.
4. **The Node-free rule needs tooling.** Requiring extension cores to be
   free of Node imports is the price of every target working. It is
   only bearable if the kit ships the closure check and a scaffold
   (`create-urlcode-extension`) that starts an extension in the right
   shape, so third parties can add extensions on the same seams without
   reading the runtime's source.

One tension remains and should stay visible: two tiers of trust. An
operator who installs an extension trusts it completely; a project author
is trusted with nothing. That is the browser's model (extensions versus
pages) and it is right for a runtime that hosts other people's YAML, but
it means the extension repositories carry the security burden of the
whole system. The review before 1.0, the threat models and the dependency
policy in the auth spike are that burden made explicit.

## 6. How to make it better than the alternatives

The feature table in section 4 is the floor. What makes it the choice is
below, ordered by leverage.

1. **Five minutes to a passkey sign-in, visibly.** `npm create urlcode`
   asks three questions and produces a site with auth on; a public demo
   runs the cookbook with the accounts page; the README's first screen is
   that demo. Measure the time and print it in the docs.
2. **Import from where people are.** Importers for Clerk, Supabase,
   Auth.js and Firebase user exports, including verifying their password
   hashes (bcrypt and PBKDF2 alongside scrypt and Argon2id, recorded per
   hash and upgraded on sign-in). Nobody switches auth if their users
   must reset passwords.
3. **Built for the AI that builds with it.** A `llms.txt` per package,
   the schema published to SchemaStore for editor completion, errors that
   name the YAML key and the fix, and an MCP server that exposes
   `validate`, `audit`, `test`, `routes --compare` and `doctor` so an
   agent can check its own work before a human sees it. The runtime's
   fixtures and audit already make a project checkable; this makes it
   checkable from inside the tools people build with.
4. **Extension authoring for third parties.** The scaffold, the closure
   check, the seam contracts as published types, and one worked example
   (`forms`) small enough to read in an hour. A platform with two
   first-party extensions is a product; one with twenty third-party ones
   is an ecosystem.
5. **Starters that are products.** A links site, a docs site, a
   members-only site and a small SaaS skeleton, each a YAML project with
   fixtures, each the answer to "what does this look like finished".
6. **Trust made public.** The threat models, the independent review's
   report, the release provenance and the benchmarks published, not
   summarised. This is the answer to "why not a vendor".
7. **The edge story finished.** Cloudflare with the D1 backend and the
   `--extension` build is the deployment nobody else offers for a full
   accounts system in a Worker; it should be the second target, not the
   fourth.
8. **Operations that a small team can run.** One store, one export, one
   restore drill, `doctor` for every target, the breach-response
   commands, and the compliance evidence export: the argument that
   self-hosting is not a burden is that these exist.

## 7. Forkable by design

Apache-2.0 makes forking legal. The design has to make it practical: a
team should be able to take `urlcode-auth`, change what they disagree
with, publish `acme-auth`, and have every project that says `extension:
auth` work with it unchanged. That is only possible if the *name* in the
YAML is a contract and the package is one implementation of it.

**The contract is separate from the implementation.** For each extension
kind there is a small contract package, owned by the runtime's
organisation, versioned by semver, with no code that does anything:

```
@jimhoyd/urlcode-auth-contract
  schema/        the JSON schema for extensions.auth and for policies.auth
  routes.md      the routes an implementation must serve under its mount and what each returns
  collections/   the store collections, keys and indexes an implementation uses
  view-models/   the typed view model of every page, versioned
  copy/          the catalogue ids and the English strings
  fixtures/      request fixtures every implementation must pass
  conformance/   a test suite that runs against any implementation
```

The original and every fork depend on the contract, never on each other.
A fork that keeps the contract is a drop-in: same YAML, same templates,
same translations, same admin extension on top. A fork that changes the
contract picks a new name (`extension: acme-auth`) and its own contract
package, and is honest about not being a drop-in. The runtime's
`extensions` seam only cares that exactly one plugin claims a name.

**What the runtime provides so forks need nothing private:**

- The seam types (`Plugin`, `PolicyModule`, the store contract, the
  context bag, the fixtures shape) as published declarations from
  `@jimhoyd/urlcode`, with semver and a deprecation window. Nothing an
  extension needs is reachable only through an unexported path.
- `provides: 'auth'` in a plugin's registration, distinct from the
  package name, so `admin` requires "a plugin providing `auth` at
  contract `^1`", not `@jimhoyd/urlcode-auth`.
- The conformance runner: `urlcode extension conform --contract
  @jimhoyd/urlcode-auth-contract --host-file host.js` runs the fixtures
  and the conformance suite against whatever is installed.

**What each extension repository does so a fork is an afternoon, not a
month:**

- One package per repository, the runtime's own CI workflows, release
  scripts and container build copied rather than referenced, so the fork
  builds and releases on its own the day it is created.
- No product name, colour or URL in code or templates; everything comes
  from the theme block and the catalogue, so a fork is not full of the
  original's branding.
- No telemetry, no update check, no call home. A fork has nothing to
  remove.
- `FORKING.md` at the root: what to rename, which contract version the
  code implements, how to run conformance, how to publish under a scope,
  and the trademark rule: the runtime's name is not granted by the
  licence, so a fork is `acme-auth`, not `urlcode-auth-acme`, while
  `provides: 'auth'` stays.
- The scaffold, `create-urlcode-extension`, creates a new extension in
  the same shape, and `--from @jimhoyd/urlcode-auth` creates a fork with
  the renames done.
- Contract changes are proposals on the contract repository, not commits
  to an implementation, and the original implementation has no special
  standing there beyond being first.

**Why this is worth the extra package.** It is the same discipline the
runtime applies to YAML: behaviour is declared in a portable document and
any conforming host runs it. Applied to extensions, the portable document
is the contract and any conforming implementation serves it. It also
keeps the original honest: if the contract is good enough to fork
against, it is good enough to build against.

## 8. The work, by repository

What sections 5 through 7 add, placed where it belongs. Nothing here is
started.

| Repository | Adds |
|---|---|
| `urlcode` (runtime) | The four seams and the store additions (with aggregates); `--host-file`; the Cloudflare `--extension` build option; `provides` and contract-version matching in plugin registration; the conformance runner; published seam types with a deprecation policy; hooks that call a project function in the guest with typed input and verdict; the schema on SchemaStore; `llms.txt` per published entry; an MCP server exposing `validate`, `audit`, `test`, `routes --compare`, `verify-deployment` and `doctor`; `npm create urlcode` with the three questions; the four product starters; the public demo |
| `urlcode-ui` | The kit; the closure check as a reusable test; `create-urlcode-extension` with `--from`; the worked `forms` example |
| `urlcode-auth-contract`, `urlcode-admin-contract`, `urlcode-ui-contract` | Schema, routes, collections, view models, copy ids, fixtures, conformance |
| `urlcode-auth` | The first release as scoped, plus bcrypt and PBKDF2 verification for imported hashes and a generic JSON import; Clerk, Supabase, Auth.js and Firebase importers next; `FORKING.md`; threat model; the pre-1.0 review |
| `urlcode-admin` | Dashboard and users as specified; requires a provider of `auth`, not a package; `FORKING.md` |

Cloudflare moves to the second target after `node`, before Vercel and
AWS, because it is the deployment no alternative offers for a full
accounts system.
