# @jimhoyd/urlcode-forms

## Unreleased

- A 422 whose errors include a field the page does not render no longer shows
  only "Correct the highlighted fields." (#739). The alert names a declared
  field the page does not render (an `only()` handle's other fields, now
  "cannot be changed on this form") by its label, and reports any undeclared
  submitted name with the fixed "This form received a field it does not
  accept.", never echoing the name or a submitted value. This applies to flows
  forms serves and to exported flows, including form-records' create and edit
  pages. An undeclared field named `__proto__` is now refused like any other
  rather than silently dropped.

- A typed export for other extensions (#529): `host()` now returns
  `FormsExports` (contract version 1), read with `ctx.get('forms')` by an
  extension that requires forms. `define(name, body)` validates a flow body
  (the new `formFlowBodySchema`: a flow without `mount`) with the same rules as
  a declared flow, and the handle renders, admits and confirms it with forms'
  escaping, same-origin admission, body bound, CSRF and 422 handling. Its CSRF
  tokens carry a `scope`, so a token for one consumer page is refused on
  another and never admits a forms-served flow; `only(names)` narrows the
  admitted fields for an edit page. `createForms` returns the registration and
  the exports; `createFormsExtension` is unchanged. Flows declared under
  `extensions.forms.config.flows`, and their tokens, behave as before.

- The same-origin check (`Origin`, and the `Referer` fallback) admits the
  operator's site-wide alias origins (`--alias-origin`, `aliasOrigins`) beside
  the canonical origin, using core's `isSiteOrigin`; unlisted origins are
  still refused (#717).

- `date` and `datetime-local` bounds can be relative (#705): `minimum` and
  `maximum` accept `today` or `{from: today, add: <duration>}`, a signed ISO
  8601 duration of years, months and days such as `-P18Y`, `P30D` or `P1Y6M`.
  Today is the date in the flow's new `timeZone` (an IANA name), or UTC when it
  is absent, never the host's zone. Years and months move first and clamp to
  the month end (31 January + `P1M` is 28 or 29 February), then days. For
  `datetime-local`, a relative minimum is 00:00 and a relative maximum the end
  of that day. The server resolves the bounds per request, and that check is
  authoritative. The rendered `min`/`max` are computed when the page is served,
  so they can go stale across midnight. Activation refuses unknown zones,
  durations with weeks or time parts, and two relative bounds whose window is
  empty on some day.
- **Default behavior change:** `urlcode extensions add` (and `init --with`) now installs only the capability; the new `--example` flag, the same for every extension, writes the sample behavior it used to write by default (#711). A blank `extensions add forms` writes the CSRF key and an empty `flows` block (`flows` may now be empty) and mounts nothing; `--example` writes the `/contact` flow and route. To reproduce the old result, add `--example`.
- A field can be required conditionally with `requiredWhen: {field, in}`
  (#528): it is required when a sibling `select` or `enum` field was submitted
  with one of the listed values, and optional otherwise, with the same 422
  `is required` error. Activation refuses an undeclared, self-referencing,
  free-text or itself-conditional sibling, an `in` value the sibling does not
  allow, and `requiredWhen` together with `required`. Enforcement is
  server-only; AND/OR, not-equal, comparisons and show/hide stay in `onSubmit`.
- `minimum` and `maximum` now bound `type: date` and `type: datetime-local`
  fields as well as `type: number` (#528). A date bound is a `YYYY-MM-DD`
  string and a date-time bound a whole-minute `YYYY-MM-DDTHH:MM` string;
  activation refuses malformed bounds and a `minimum` later than `maximum`, a
  submission outside the bounds gets a 422 field error ("must be on or after
  …" / "must be on or before …"), and the input renders the matching HTML
  `min` and `max` attributes.
- The confirmation page can show submitted values the flow opts in to with
  `confirmation.show`, and `confirmation.message` may place them as `{field}`
  placeholders (#527). The values reach the confirmation in an encrypted,
  browser- and flow-bound `__Host-urlcode-forms-confirmation` cookie that
  expires after 5 minutes and is cleared on read, never in the URL; a missing,
  expired, tampered or foreign one renders the fixed page. Startup refuses a
  `show` entry that is not a declared field and a placeholder not listed in
  `show`, so a message that already contained `{name}` text must now list the
  field or drop the braces.
- `type: date` and `type: datetime-local` fields are now validated on
  submission (#682). A `date` value must be `YYYY-MM-DD` and a
  `datetime-local` value `YYYY-MM-DDTHH:MM` with optional seconds and up to
  three fractional-second digits, with no timezone offset; impossible calendar
  values such as `2026-02-30`, month 13 or hour 24 are refused with a 422 field
  error. Previously any string was accepted.
- `onSubmit` receives core's generic hook context, `{requestId, env}`, as a
  second argument (#678).

## 0.5.0

Initial package source. Not yet published to npm or included in a signed
`extension-bundles@v…` release; see [docs/FRAMEWORK.md](../../docs/FRAMEWORK.md)
for current distribution status.
