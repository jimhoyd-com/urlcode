# Security boundary

`form-records` is trusted operator code that runs in the host process. It is
not a sandbox or a multi-tenant boundary. Project configuration names a form,
an owned store collection, a field mapping and the editable fields; it cannot
select a module, a secret, a storage directory or a provider.

An operator-reviewed project revision (which `composeHost` in the site's
`host.mjs` takes from the `--policy` file or `PROJECT_SHA256` and passes to
`host()` as `context.projectSha256`) is required; the extension refuses to
register without it.

## What it relies on

form-records adds no parsing, token or storage code of its own. It delegates:

- **Request admission and CSRF to forms.** Every POST goes through forms'
  exported `submit`: a present `Origin` must be a site origin (otherwise
  `Sec-Fetch-Site`, then `Referer`), the body must be URL-encoded and at most
  64 KiB, and the signed token must match the browser's binding cookie, the
  form's name and the page's scope. Scopes separate the create page from each
  record's edit page, and a scoped token never admits a flow forms serves
  itself. See the [forms security notes](../forms/SECURITY.md) for the token's
  lifetime and replay properties; they apply unchanged.
- **Field validation and HTML escaping to forms.** Pages are rendered by
  forms through the ui kit; form-records emits no HTML.
- **Ownership, limits and concurrency to store.** Every read and write passes
  the request principal to the store's exported records API, which scopes it:
  another user's record and a missing id are the same 404. Creates stamp the
  principal as owner, updates carry `If-Match` from the version the edit page
  was rendered from, and `maxRecords`, `maxRecordBytes` and field rules apply
  exactly as on the store's JSON API.

## What it enforces itself

- It refuses to activate on a collection that is not `ownership: owner`, on a
  `readOnly` collection, or on a mount whose route has no principal-providing
  policy, so a record is never served without an owner check. A request that
  still arrives without a principal gets 401 and reads nothing.
- The edit page admits only the declared `editable` fields; any other field in
  a submission is a 422 and nothing is saved. Updates are partial: fields
  outside `editable` are never sent to the store.
- The record version in the edit form's action is only a hint the store checks
  (`If-Match`); a forged or stale version is refused with 412, never trusted to
  skip the check.
- Store failures reach the caller as fixed messages: field errors by name,
  one line for a full collection or an oversized record, and a generic 500 for
  anything unexpected. No path, stack or stored value from another user is
  echoed.

## Limits

- Records are private to the principal that created them. There is no sharing,
  no administrator view and no list page in this extension.
- The store is a single-writer file directory on Node; so is this composition.
- Passing tests does not establish independent security assessment, hostile
  multi-tenant readiness, production abuse resistance, or delivery guarantees.

Report suspected vulnerabilities through the repository's private reporting
channel described in the root SECURITY.md.
