# URLCode UI

Shared presentation for URLCode core, auth and admin. Apache-2.0, private/unpublished
while integration is reviewed. No production dependencies or auth/runtime imports.

```ts
import {createPresentation,renderDocument,field,button} from '@jimhoyd/urlcode-ui';
const presentation=createPresentation({
  defaults:{'page.home':'Welcome'},
  theme:{'--ui-accent':'#0645ad'},
}).resolve();
const html=renderDocument({
  title:presentation.text('page.home'),presentation,
  trustedContent:field({name:'email',label:'Email',type:'email'})+button('Continue'),
});
```

The consuming application owns form actions, CSRF, validation and authorization.
Never pass untrusted HTML as trustedContent. See SECURITY.md and CONTRACT.md.

## Core without auth or admin

An operator build can render a page with this package, write the resulting HTML to
`public/welcome.html`, then use an ordinary URLCode page route:

```yaml
version: '1'
routes:
  /welcome:
    page:
      file: public/welcome.html
```

This requires no auth/admin import or extension registry. Rendering inside a trusted
operator extension is also possible; project code never gains host module loading.
Core's redirect-only runtime does not acquire a mandatory private-package dependency.

For local review, run `npm ci`, `npm run verify`, then `npm pack --ignore-scripts`.
Install the resulting archive into a consumer before installing auth and admin.
Do not publish a package as a workaround for local peer resolution.

## Tailwind and shadcn styling

Run `npm run styles` after checkout before source-only typechecks. `npm run build`
and `npm run verify` compile Tailwind automatically, with no consumer CSS setup.
The shipped stylesheet contains shadcn token/primitive adapters and responsive
layout patterns. See THIRD-PARTY-NOTICES.md for upstream source and MIT attribution.
The default entry point stays dependency-free; Tailwind is a build dependency.
Auth and admin screens remain in their own packages.

## Appearance selection

Pass `theme: { nonce }` to `renderDocument` to enable the localized System/Light/Dark
selector. The host must allow that unpredictable per-response nonce in its CSP
`script-src`; never enable unsafe inline scripts. The static bootstrap runs before
paint and saves only the appearance enum in local storage. Storage denial falls
back gracefully. Without the option or with scripts disabled, CSS follows the
system preference and all native forms/navigation still work.
