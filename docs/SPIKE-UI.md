# Spike: the shared template kit (`urlcode-ui`)

Status: proposal, nothing implemented. The [auth](SPIKE-AUTH.md) and
[admin](SPIKE-ADMIN.md) extensions both render pages, and more extensions
will. The pages must look like one product, be restyled by a project once
for all of them, and never require a client framework or a build step in
the project. That is one package, built before either extension, and it
is the only place templates, styling and copy mechanics live.

## 1. The path a project takes

```
urlcode            a site: redirects, pages, static files, live links, policies, site conventions
  + urlcode-auth   when the site gets serious: accounts, sign-in, roles, route protection
  + urlcode-admin  when there are enough people: manage users, sessions, roles, audit
  + later          organizations and SSO, and whatever extension comes next
```

Each step is `npm install` plus `npx <package> init`, which writes one
included YAML file and one plugin line. The runtime never depends on any
extension; each extension depends on the runtime and on `urlcode-ui`;
`admin` also depends on `auth`. A site that only ever hosts redirects
carries none of it.

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
- **Copy catalogue**: every string in every template has an id; the kit
  ships English; a project supplies a catalogue file with only the ids it
  wants changed or translated.
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

The kit has no runtime dependency; it renders strings. Extensions bind it
to routes.

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
    copy: ui/copy.en.yaml            # only the ids to change
    languages: [en, fr]              # ui/copy.fr.yaml must exist
    templates: ui/templates          # any file here shadows a kit or extension template by name
    stylesheet: ui/extra.css         # appended after the kit's CSS
```

Four levels of change, from lightest to heaviest. Most projects stop at
the first or second.

1. **Theme only.** Colours, radius, font, logo, name. No files beyond the
   logo. Every auth and admin page follows.
2. **Copy.** A catalogue file with a handful of ids: rename "Sign in" to
   "Log in", change the welcome sentence, add a language. Templates are
   untouched.
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

## 4. Why a separate package now

Two extensions already need the same layout, copy mechanism and override
order; writing it twice means two ways to restyle and two sets of bugs.
More extensions are planned. The kit is also the smallest of the three
packages and the only one with no security surface, so it can be built
first and iterated fast while the runtime seams for auth are reviewed.

## 5. Open questions

- The template language: a tiny custom one (slots, `if`, `each`) keeps
  escaping enforceable; adopting an existing engine gives familiarity but
  invites logic in templates. The proposal is the tiny one.
- Whether the kit CSS can be served from the runtime's static handler
  rather than each extension's mount, to avoid serving the same file
  twice when two extensions are active.
