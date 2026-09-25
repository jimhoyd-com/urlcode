# @jimhoyd/urlcode-form-records

## Unreleased

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
