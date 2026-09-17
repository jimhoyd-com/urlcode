# Review: the extension model, its precedents and its alignment

Status: review of the [auth](SPIKE-AUTH.md), [admin](SPIKE-ADMIN.md) and
[UI kit](SPIKE-UI.md) spikes against the runtime's principles and against
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
