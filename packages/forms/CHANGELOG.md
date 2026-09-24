# @jimhoyd/urlcode-forms

## Unreleased

- `type: date` and `type: datetime-local` fields are now validated on
  submission (#682). A `date` value must be `YYYY-MM-DD` and a
  `datetime-local` value `YYYY-MM-DDTHH:MM` with optional seconds and up to
  three fractional-second digits, with no timezone offset; impossible calendar
  values such as `2026-02-30`, month 13 or hour 24 are refused with a 422 field
  error. Previously any string was accepted.

## 0.5.0

Initial package source. Not yet published to npm or included in a signed
`extension-bundles@v…` release; see [docs/FRAMEWORK.md](../../docs/FRAMEWORK.md)
for current distribution status.
