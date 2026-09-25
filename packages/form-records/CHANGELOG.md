# @jimhoyd/urlcode-form-records

## Unreleased

- Clearing an optional field on the edit page, and an optional per-user list
  page (#738). An editable field emptied on the edit page is now removed from
  the record (the store's partial update with `null`) rather than saved as
  empty text or, for a number, refused; a required collection field refuses
  the clear with a 422 field error. A record flow may declare `list: {title?,
  columns}`: `<mount>/` then lists the signed-in user's own records (the
  store scopes them), 20 per page at most with the store's cursors, each with
  View and, when `editable` is set, Edit links, and the confirmation links back
  to it. Columns must be form fields (checked at activation). Without `list`,
  nothing changes. form-records now also requires `ui`, which renders the list
  page; `createFormRecordsExtension` accepts `ui` and needs it only for a
  `list`.

- First release (#529). A separate, operator-installed extension that requires
  `forms` and `store` and owns their composition: a declared form's validated
  submission creates a record in an `ownership: owner` store collection, a
  confirmation page reads the saved record back, and an edit page pre-fills and
  changes only the declared `editable` fields through a partial update. It uses
  forms' and the store's typed exports (contract version 1) and never reads
  their configuration. Activation refuses a shared or read-only collection, a
  mount without a principal-providing policy, an unmapped form field, a type
  mismatch and forms or store declared after it. Another user's record is a
  404; a stale edit is a 412 page with the current values; forms' CSRF,
  admission and 422 handling hold on every page. Node only. The capability
  install adds no route; `--example` (with auth) adds a signed-in todo form
  over the store example's `todos` collection.
