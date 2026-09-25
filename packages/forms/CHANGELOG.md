# @jimhoyd/urlcode-forms

## Unreleased

- `minimum` and `maximum` now bound `type: date` and `type: datetime-local`
  fields as well as `type: number` (#528). A date bound is a `YYYY-MM-DD`
  string and a date-time bound a whole-minute `YYYY-MM-DDTHH:MM` string;
  activation refuses malformed bounds and a `minimum` later than `maximum`, a
  submission outside the bounds gets a 422 field error ("must be on or after
  …" / "must be on or before …"), and the input renders the matching HTML
  `min` and `max` attributes. Bounds are absolute; relative dates are not
  supported.
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
