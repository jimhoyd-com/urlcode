# Spike: the shared template kit (`urlcode-ui`)

Status: design proposal, kept as the source plan. The implementation lives in this repository; [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md) and [CONTRACT.md](../CONTRACT.md) record what is built and take precedence where this text differs. The [auth](https://github.com/jimhoyd-com/urlcode-auth/blob/main/docs/SPIKE-AUTH.md) and
[admin](https://github.com/jimhoyd-com/urlcode-admin/blob/main/docs/SPIKE-ADMIN.md) extensions both render pages, and more extensions
will. The pages must look like one product, be restyled by a project once
for all of them, and never require a client framework or a build step in
the project. That is one package, built before either extension, and it
is the only place templates, styling and copy mechanics live.

## 1. The path a project takes

```
urlcode            a site: redirects, pages, static files, functions, policies, site conventions
  + urlcode-auth   when the site gets serious: accounts, sign-in, roles, route protection
  + urlcode-admin  when there are enough people: manage users, sessions, roles, audit
  + later          organizations and SSO, and the next extensions
```

Candidates for the next extensions, each a separate package on the same
seams, none designed yet: `forms` (contact and lead forms with a sender
and a store collection), `subscribe` (newsletter sign-up with double
opt-in and the consent record), `billing` (subscriptions through a
payment provider bound in the host file, entitlements as auth
permissions), `uploads` (files with a storage backend and signed links),
`search` (an index over the project's pages). Each is the same shape:
routes, a store collection, pages on the kit, a YAML block, a plugin
line.

Each step is `npm install` plus `npx <package> init`, which writes one
included YAML file and one line in the host file. The runtime never
depends on any extension; each extension depends on the runtime and on
`urlcode-ui`; `admin` also depends on `auth`. A site that only ever hosts
redirects carries none of it.

The host file is the one piece of code a project with extensions has. It
is operator code, loaded by `urlcode serve --host-file host.js` the way
`--policy` and `--compliance-rules` load operator files today, and never
discovered by convention inside the project, because the project is
untrusted application content. It exports the store, the plugins and the
senders; `init` writes it and the starter's `make dev` and `make serve`
pass it.

## 2. What the kit is

`@jimhoyd/urlcode-ui`, repository `jimhoyd-com/urlcode-ui`:

- **Templates**: a minimal template language with slots, conditionals and
  loops, no expressions, no logic, no code. A template receives a
  documented, versioned view model and can only place its fields.
  Escaping is on by default and cannot be turned off from a template.
- **Partials** in shadcn/ui markup: `layout`, `nav`, `card`, `form`,
  `field`, `button`, `alert`, `otp`, `table`, `tabs`, `menu`, `empty`,
  `pagination`. Extensions compose pages from these and add their own
  page templates.
- **CSS**: one stylesheet compiled from Tailwind at kit publish time
  against every partial and every registered extension template, purged,
  hashed, served as a static asset under each extension's mount with
  `immutable` caching. Dark mode by `prefers-color-scheme` and a class.
- **Theme**: the shadcn/ui CSS variables, plus logo, product name,
  favicon and the "back to site" link, read from a `theme` block so a
  project restyles once for every extension.
- **Copy catalogue and translations, from day one**: every string in
  every template and every notice has an id; the kit ships English and
  the mechanism, and any language is a catalogue file. Language is
  negotiated per request from the signed-in account's preference, then
  `?lang`, then `Accept-Language`, then the project's default. Catalogues
  carry plural rules per language, dates and numbers format by locale,
  the templates are RTL safe (`dir` set from the language, logical CSS
  properties throughout), and a missing id falls back to English and is
  reported by `doctor`. Notices are rendered in the recipient's language.
  Extensions register their catalogues with the kit so a project
  translates auth and admin in one file per language.
- **Override resolution**: one algorithm, shared by all extensions, for
  finding a template, a partial, a copy id or a theme value: project file,
  then extension default, then kit default.
- **Tools**: `eject` to copy a template or partial into the project,
  `doctor` to list every override in effect and any template written
  against an older view model, `preview` to render any page with sample
  data.
- **Scripts**: a few small, nonce-served enhancements (OTP boxes,
  passkey ceremony, tabs, confirm-by-typing). Every page works without
  them except passkeys.
- **Accessibility**: WCAG 2.2 AA as a test in the kit, run against every
  partial and every extension's pages.

The kit has no runtime dependency; it renders strings. It ships one tiny
plugin of its own that owns the `extensions.ui` block and serves the
compiled stylesheet and scripts at one route (`/assets/ui/*: { extension:
ui }`, written by the first extension's `init`), so two extensions never
serve the same file twice and the block has exactly one owner, as the
runtime's extension seam requires.

## 3. How a project configures and styles it

Everything a project can change sits in one `ui` block, written once in
`urlcode.yaml` or in any included file, and every extension reads it:

```yaml
extensions:
  ui:
    theme:
      name: Acme Links
      logo: public/logo.svg
      favicon: public/favicon.svg
      backTo: /
      colors:                       # shadcn/ui variables, light and dark
        primary: "24 95% 53%"
        background: "0 0% 100%"
        dark: { primary: "24 95% 60%", background: "224 71% 4%" }
      radius: 0.75rem
      font: "Inter, system-ui, sans-serif"
    languages: [en, fr, ar]          # first is the default; ui/copy.<lang>.yaml per language, only the ids to change
    copy: ui/copy                    # directory of catalogues
    templates: ui/templates          # any file here shadows a kit or extension template by name
    stylesheet: ui/extra.css         # appended after the kit's CSS
```

Four levels of change, from lightest to heaviest. Most projects stop at
the first or second.

1. **Theme only.** Colours, radius, font, logo, name. No files beyond the
   logo. Every auth and admin page follows.
2. **Copy and languages.** A catalogue file per language with only the
   ids to change: rename "Sign in" to "Log in", change the welcome
   sentence, add French and Arabic. Plurals, dates and direction follow
   the language. Templates are untouched. `urlcode-ui copy --missing fr`
   lists what a language still lacks.
3. **Templates.** `npx urlcode-ui eject layout` copies the layout into
   `ui/templates/layout.html`; the project wraps the pages in its own
   header and footer and leaves every page alone. Or eject one page
   (`auth/sign-in`) and rearrange it. The view model each template
   receives is documented and versioned; when a kit release changes one,
   `doctor` names the ejected templates that are behind, and the old
   template keeps working until the view model's major version moves.
4. **Stylesheet or full restyle.** An extra stylesheet after the kit's,
   or a project that runs its own Tailwind build over its ejected
   templates and points `stylesheet` at the result while turning the kit
   CSS off with `stylesheet: { replace: true, file: … }`.

What a project cannot change from templates: which steps a flow has,
what a form validates, what gets escaped, what a page sends in headers.
Those are behavior and live in the extension's YAML keys or in the
extension itself. A template that tries to add a script tag without the
nonce gets it stripped by the renderer.

## 4. Forkable and extendable by others

The kit has a contract too (`@jimhoyd/urlcode-ui-contract`: the template
language, the partial names, the view-model versioning rule and the
catalogue format), so a fork of the kit can restyle everything for every
extension at once, and an extension written by a third party renders on
the original or the fork alike. The kit repository also carries
`create-urlcode-extension`, which scaffolds a new extension in the right
shape, and `--from <package>` which starts a fork with the renames done.
See the [extension model review](https://github.com/jimhoyd-com/urlcode/blob/main/docs/SPIKE-EXTENSION-MODEL.md) section 7.

## 5. Why a separate package now

Two extensions already need the same layout, copy mechanism and override
order; writing it twice means two ways to restyle and two sets of bugs.
More extensions are planned. The kit is also the smallest of the three
packages and the one with the narrowest dependencies — it owns no identities,
credentials, sessions, authorization or network calls — so it can be built first
and iterated fast while the runtime seams for auth are reviewed. That is not the
same as having no security surface: presentation *is* a security boundary here
(see `SECURITY.md` and `THREAT-MODEL.md`), and changes to escaping, `href` and
URL handling, script construction, CSP or nonces get the same review scrutiny as
anything in auth.

## 6. Open questions

- The template language: a tiny custom one (slots, `if`, `each`) keeps
  escaping enforceable; adopting an existing engine gives familiarity but
  invites logic in templates. The proposal is the tiny one.
- Which languages beyond English ship in the first release, if any:
  the mechanism is day one, the catalogues need native review.
