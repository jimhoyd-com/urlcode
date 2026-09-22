# shadcn/ui

The Button, Input and Card styling adapters use the official shadcn/ui New York
registry component recipes (MIT, copyright shadcn). Original registry source is
preserved in `vendor/shadcn/{button,input,card}.json` in the repository (the
snapshots are not part of the published package; only `vendor/shadcn/LICENSE.md`
ships), retrieved 2026-09-18 from
https://ui.shadcn.com/r/styles/new-york/. The complete upstream license is included
at `vendor/shadcn/LICENSE.md`; URLCode's own Apache-2.0 license is unchanged.

These are server-rendered HTML adapters, not React/Radix components. The shared
styles use the same Tailwind recipes and semantic shadcn theme tokens for buttons,
inputs and cards. Native form, details, navigation and table semantics implement
interaction; no client framework, hydration, remote CSS or script is required.
Tailwind CSS is compiled at build time using the official CLI. React-only shadcn
components are not advertised or exported. The registry snapshots are attribution
and review inputs, not executable project templates.
