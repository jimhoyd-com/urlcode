# @jimhoyd/urlcode-form-records

An operator-installed URLCode extension that saves a declared form into an
owned [store](../store/README.md) collection. A signed-in user submits the form,
the record is created as theirs, a confirmation page reads the saved record back,
an edit page lets its owner change only the fields you list, and an optional
list page shows each user their own records. Nothing else is written by hand:
no handler, no in-process map, no HTML.

It composes two other add-ons (and renders its optional list page through
[ui](../ui/README.md)) and owns only the composition:

- [forms](../forms/README.md) renders the form and keeps escaping, same-origin
  admission, body bounds, CSRF and field validation (403, 413, 415, and a 422
  page with field errors).
- [store](../store/README.md) keeps the record: per-record ownership, field
  validation, `maxRecords`, `maxRecordBytes` and strong ETags.

form-records never reads `extensions.forms.config` or `extensions.store.config`.
It reaches both through their typed exports, contract version 1 (`FormsExports`
and `StoreExports`, read with `ctx.get`, beside ui's kit), as the
[generic add-on authoring rules](../../docs/EXTENSIONS.md#generic-add-on-authoring-rules)
require. It is released with core, at core's version, and installed with
`urlcode extensions add form-records`, which also adds `forms`, `store` and `ui`
when the site lacks them.

## Declare a record flow

```yaml
extensions:
  ui: { version: "1", config: {} }
  auth: { version: "1", config: {} }           # or any other principal provider
  forms: { version: "1", config: { flows: {} } }
  store:
    version: "1"
    config:
      collections:
        profiles:
          mount: /api/profiles
          ownership: owner                     # required: records are private to their creator
          fields:
            name: { type: string, required: true, maxLength: 80 }
            team: { type: string, enum: [red, blue], default: red }
            subscribed: { type: boolean, default: false }
            notes: { type: string, maxLength: 200 }
  form-records:                                # any order: the runtime activates forms and store first
    version: "1"
    config:
      records:
        onboarding:
          mount: /onboarding
          collection: profiles
          form:                                # a forms flow without a mount
            title: Join the team
            submitLabel: Join
            confirmation: { title: Welcome, message: "Saved {name}.", show: [name, team] }
            fields:
              name: { label: Name, maxLength: 80 }
              team: { label: Team, control: select, options: [{ value: red, label: Red }, { value: blue, label: Blue }] }
              subscribed: { label: Subscribe, control: checkbox, required: false }
              bio: { label: Bio, control: textarea, required: false, maxLength: 200 }
          fields: { name: name, team: team, subscribed: subscribed, bio: notes }
          editable: [team, subscribed]
          editTitle: Edit your profile
          list: { title: Your profiles, columns: [name, team] }   # optional
routes:
  /api/profiles/*: { extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true }
  /onboarding/*: { extension: form-records, methods: [GET, HEAD, POST], auth: true }
```

| Key | Meaning |
| --- | --- |
| `records.<name>` | One record flow. The name is also the form's name in CSRF tokens (`^[a-z][a-z0-9-]{0,63}$`); at most 16. |
| `mount` | Where it is served; needs the route `<mount>/*` with `extension: form-records`, methods GET, HEAD and POST, and a principal-providing policy such as `auth: true` (forms verifies its own CSRF token on every POST). |
| `collection` | A store collection declared with `ownership: owner` and not `readOnly`. |
| `form` | A forms flow body: `title`, `submitLabel`, `confirmation` (`title`, `message`, `show`), `fields`, optional `timeZone` and `success`. The same shape and rules as a flow under `extensions.forms.config.flows`, without `mount`. `success: {mode: inline, status: 200\|201}` answers a create with the saved record's confirmation instead of a 303 (a 201 also carries `Location: <mount>/<id>`); an edit answered inline is always 200, because it creates nothing. |
| `fields` | Form field to collection field. Optional: each form field defaults to the collection field of the same name. Every form field must be mapped, two form fields cannot fill one collection field, and every required collection field without a default must be filled. |
| `editable` | Form fields the edit page may change. Every other field is read-only after create. Empty or absent: no edit page. |
| `editTitle` | The edit page title. Default: the form's title. |
| `list` | Optional. A page at `<mount>/` listing the signed-in user's own records: `columns` (1 to 8 distinct form fields, shown in that order from the collection fields they fill) and `title` (default `Your records`). Absent: no list page. |

A form field fills a collection field of a matching type: a `checkbox` fills a
`boolean`, an input with `type: number` fills an `integer` or `number` (a
fraction for an `integer` is a 422 "must be a whole number"), and every other
control fills a `string`. Activation refuses any other pairing, as it refuses
every other problem above, with a message naming the record flow.

## What it serves

| Path | GET / HEAD | POST |
| --- | --- | --- |
| `<mount>` | The empty form | Create: 303 to `<mount>/<id>` (with `form.success` inline, the record's confirmation in the response: 201 with `Location: <mount>/<id>`, or 200), or the form again with errors |
| `<mount>/` (with `list`) | The caller's own records, 20 per page at most (fewer when the collection's `pageSize` is smaller), in creation order, with a View link to each confirmation, an Edit link when `editable` is set, and Previous/Next page links (`?cursor=<offset>`, the store's cursor) | As `<mount>` |
| `<mount>/<id>` | The confirmation: the form's `confirmation` with its `show` fields read from the saved record, an Edit link when `editable` is set, and a link to the list when `list` is set | 405 |
| `<mount>/<id>/edit` | The editable fields pre-filled, the other fields as a read-only list | Partial update: 303 to `<mount>/<id>` (with `form.success` inline, the record's confirmation with 200), or the form again with errors |

- **Ownership.** Every request needs a principal; without one the answer is
  401 and nothing is read. A record another user created, and an id that does
  not exist, both answer 404, on the confirmation, the edit page and an edit
  submission alike: form-records passes the request principal to the store,
  which scopes every read and write.
- **Constrained updates.** The edit page renders and admits only the
  `editable` fields (through forms' `only()`); a submission that carries any
  other field is a 422 and changes nothing. The update sends only those fields
  (the store's partial update), so the rest of the record is unchanged. An
  editable field emptied on the edit page is removed from the record (the
  update sends `null`, which the store's partial update treats as "clear this
  field"; #738). When the collection field it fills is required, the store
  refuses that and the page is shown again with a 422 and "is required and
  cannot be cleared" on the field.
- **List page.** With `list`, `<mount>/` (exactly, with the trailing slash;
  `<mount>` stays the new-record form) lists the caller's records only: the
  collection is owned, so the store scopes the page, its `total` and its
  cursors to the principal. Values are escaped, a checkbox reads Yes/No and a
  select its option label, and the page is `Cache-Control: no-store`. A
  malformed `cursor` is a 400. Activation refuses a column that is not a form
  field.
- **Concurrency.** The edit page's form action carries the record version it
  was rendered from (`?v=<etag>`), and the update sends it to the store as
  `If-Match`. When the record changed since, from another tab or the store's
  JSON API, nothing is saved: the page is shown again with status 412, the
  current values and version, and a message saying the changes were not saved.
- **CSRF and admission.** forms keeps its rules on both pages. Each page's
  token is scoped (`form-records:<name>:create`, and
  `form-records:<name>:edit:<id>` per record), so a token from one page does
  not admit another, and none admits a forms-served flow.
- **Store refusals.** A store field error (a rule the form did not repeat, such
  as a shorter `maxLength`) returns the form with a 422 and the error on the
  form field that filled it. A full collection (409), an oversized record (413)
  or an unavailable store (503) returns the form with that status, the values
  kept, and a page-level message. Other failures are a generic 500.

forms' `onSubmit` hook does not run for a form-records form: a valid
submission creates or updates the record. Without `list` there is no list
page, and `<mount>/` is the new-record form as before; the store's JSON API
(`GET <collection mount>`) also lists the caller's own records.

## Install

```sh
urlcode extensions add form-records             # capability: an empty records block, no route
urlcode extensions add auth form-records --example
```

The capability adds `records: {}` and mounts nothing. `--example` needs `auth`
(installed, or added in the same command), because records are private to
their creator: it declares a `todo` record flow on `/todo-form` (`auth: true`)
that saves into the store example's `todos` collection (`ownership: owner`),
shows the saved todo, and lets its owner tick `done` while the title stays
read-only. form-records writes only its own configuration block, so the
`todos` collection comes from the store's example, which is written when
`store` is added with `--example` in the same command. If `store` was already
installed, declare that collection yourself (see [STORE.md](../../docs/STORE.md)).
When audit is installed the store example's collection declares `audit: true`,
so every record the form saves or edits is recorded in the audit log with the
signed-in user as actor ([audited writes](../../docs/STORE.md#audited-writes)).

In `host.mjs`, `composeHost` passes forms' and the store's exports and ui to
`formRecords()`; it takes no operator options. The runtime activates `forms`
and `store` before `form-records` because it requires them, whatever order
`extensions` declares them in. Called directly,
`createFormRecordsExtension` takes `ui` only for a record flow that declares
`list`, and refuses such a flow without it.

## Targets

Node only. The store is Node-only (a single-writer file directory), so the
composition declares `targets: ['node']` and a build or runtime for `aws` or
`vercel` refuses it before serving.

## See also

- [SECURITY.md](SECURITY.md): the trust boundary.
- [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md): the extension contract, `ctx.get` and the request principal.
- [docs/FRAMEWORK.md](../../docs/FRAMEWORK.md): how the packages compose.

Apache-2.0.

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `form-records` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** requires `forms`, `store`, `ui` (`urlcode extensions add form-records` installs them too).

### Configuration: `extensions.form-records.config`

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.form-records.config.records` | object | yes | maxProperties: 16; keys: "^[a-z][a-z0-9-]{0,63}$" | Record flows by name. Each needs a route `<mount>/*` with extension: form-records (GET, HEAD, POST) and a principal-providing policy such as auth: true; records are private to their signed-in creator. |
| `extensions.form-records.config.records.*.mount` | string | yes | maxLength: 128; pattern: "^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$" | URL path of the flow: `<mount>` is the new-record form, `<mount>/<id>` the saved record's confirmation, `<mount>/<id>/edit` the edit page and, with list, `<mount>/` the caller's records. |
| `extensions.form-records.config.records.*.collection` | string | yes | pattern: "^[a-z][a-z0-9_-]{0,63}$" | A store collection declared with ownership: owner; each mapped form field must be type-compatible with its collection field. Activation fails otherwise. |
| `extensions.form-records.config.records.*.form` | object | yes | unknown keys rejected | The form, in the forms flow shape without a mount (and without abuse or notify); forms renders and validates it. |
| `extensions.form-records.config.records.*.form.title` | string | yes | minLength: 1; maxLength: 512 | Page heading and title of the form. |
| `extensions.form-records.config.records.*.form.timeZone` | string | no | pattern: "^[A-Za-z][A-Za-z0-9_+/-]{0,63}$" | IANA time zone (default UTC) that defines "today" for relative date bounds; refused at activation when unknown. |
| `extensions.form-records.config.records.*.form.submitLabel` | string | yes | minLength: 1; maxLength: 512 | Text of the submit button. |
| `extensions.form-records.config.records.*.form.confirmation` | object | yes | unknown keys rejected | The page a valid submission leads to. |
| `extensions.form-records.config.records.*.form.confirmation.title` | string | yes | minLength: 1; maxLength: 512 | Heading of the confirmation page. |
| `extensions.form-records.config.records.*.form.confirmation.message` | string | yes | minLength: 1; maxLength: 2048 | Confirmation text; a {field} placeholder is replaced by that submitted value (escaped) and must be listed in show. |
| `extensions.form-records.config.records.*.form.confirmation.show` | array | no | minItems: 1; maxItems: 32; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared fields whose submitted values the confirmation may display: carried in a sealed five-minute cookie on redirect, or rendered directly inline. Nothing else is echoed. |
| `extensions.form-records.config.records.*.form.success` | object | no | unknown keys rejected | What a valid POST answers: redirect (default) is a 303 to `<mount>/confirmation`; inline renders the confirmation in the POST response. |
| `extensions.form-records.config.records.*.form.success.mode` | string | yes | enum: ["redirect","inline"] | redirect or inline. |
| `extensions.form-records.config.records.*.form.success.status` | number | no | enum: [200,201] | Status of the inline confirmation (default 200); refused with mode redirect. |
| `extensions.form-records.config.records.*.form.fields` | object | yes | minProperties: 1; maxProperties: 32; keys: "^[a-z][A-Za-z0-9_]{0,63}$" | The form's fields in display order, keyed by field name (the submitted name). A field not declared here is refused. |
| `extensions.form-records.config.records.*.form.fields.*.label` | string | yes | minLength: 1; maxLength: 512 | Visible label of the field; also names it in error messages and on the confirmation. |
| `extensions.form-records.config.records.*.form.fields.*.control` | string | no | enum: ["input","textarea","select","checkbox"] | HTML control (default input). select needs options; checkbox takes no type or bounds and submits true or false. |
| `extensions.form-records.config.records.*.form.fields.*.type` | string | no | enum: ["text","email","number","tel","url","date","datetime-local"] | Input type for an input control (default text); decides which bounds apply and how the value is checked. |
| `extensions.form-records.config.records.*.form.fields.*.required` | boolean | no | — | Fields are required unless this is false. Not allowed together with requiredWhen. |
| `extensions.form-records.config.records.*.form.fields.*.minLength` | integer | no | minimum: 0; maximum: 65536 | Fewest characters a text value may have; not for number, date or checkbox fields. |
| `extensions.form-records.config.records.*.form.fields.*.maxLength` | integer | no | minimum: 1; maximum: 65536 | Most characters a text value may have; required (and bounded) when pattern is set. |
| `extensions.form-records.config.records.*.form.fields.*.minimum` | number / string / constant / object | no | one of: number; string (pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?$"); constant (const: "today"); object (fields below) | Lower bound: a number for type number; for date and datetime-local an absolute YYYY-MM-DD or YYYY-MM-DDTHH:MM value, today, or {from: today, add: `<duration>`} in the flow's timeZone. |
| `extensions.form-records.config.records.*.form.fields.*.minimum.from` | constant | yes | const: "today" | The flow's current date in its timeZone. |
| `extensions.form-records.config.records.*.form.fields.*.minimum.add` | string | yes | pattern: "^(-?)P(?=\\d)(?:(\\d{1,5})Y)?(?:(\\d{1,5})M)?(?:(\\d{1,5})D)?$" | Signed ISO 8601 period of years, months and days added to today, for example P30D or -P18Y. |
| `extensions.form-records.config.records.*.form.fields.*.maximum` | number / string / constant / object | no | one of: number; string (pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?$"); constant (const: "today"); object (fields below) | Upper bound, with the same forms as minimum; it must not be below minimum. |
| `extensions.form-records.config.records.*.form.fields.*.maximum.from` | constant | yes | const: "today" | The flow's current date in its timeZone. |
| `extensions.form-records.config.records.*.form.fields.*.maximum.add` | string | yes | pattern: "^(-?)P(?=\\d)(?:(\\d{1,5})Y)?(?:(\\d{1,5})M)?(?:(\\d{1,5})D)?$" | Signed ISO 8601 period of years, months and days added to today, for example P30D or -P18Y. |
| `extensions.form-records.config.records.*.form.fields.*.pattern` | string | no | minLength: 1; maxLength: 128 | Regular expression the whole text value must match; checked for catastrophic backtracking at activation and requires maxLength. |
| `extensions.form-records.config.records.*.form.fields.*.enum` | array | no | minItems: 1; maxItems: 128; uniqueItems: true; items: string (maxLength: 512) | Exact values an input accepts, or the subset of a select's option values it accepts. |
| `extensions.form-records.config.records.*.form.fields.*.description` | string | no | maxLength: 512 | Help text rendered under the field. |
| `extensions.form-records.config.records.*.form.fields.*.requiredWhen` | object | no | unknown keys rejected | Makes the field required only when a sibling select or enum field was submitted once with one of the listed values, and optional otherwise. Replaces required; the sibling must not itself be conditional. |
| `extensions.form-records.config.records.*.form.fields.*.requiredWhen.field` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | Name of the sibling field in this flow; it needs a fixed value set (a select or an enum input). |
| `extensions.form-records.config.records.*.form.fields.*.requiredWhen.in` | array | yes | minItems: 1; maxItems: 128; uniqueItems: true; items: string (maxLength: 512) | Values of the sibling that make this field required; each must be one the sibling accepts. |
| `extensions.form-records.config.records.*.form.fields.*.options` | array | no | minItems: 1; maxItems: 128 | Choices of a select control, in display order; only select fields take options. |
| `extensions.form-records.config.records.*.form.fields.*.options[].value` | string | yes | maxLength: 512 | Submitted value of the choice. |
| `extensions.form-records.config.records.*.form.fields.*.options[].label` | string | yes | maxLength: 512 | Visible text of the choice; the confirmation shows it for a shown select. |
| `extensions.form-records.config.records.*.fields` | object | no | maxProperties: 32; keys: "^[a-z][A-Za-z0-9_]{0,63}$"; values: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Map from form field to collection field. Default: each form field to the collection field of the same name. |
| `extensions.form-records.config.records.*.editable` | array | no | maxItems: 32; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Form fields the edit page may change; every other field is read-only after create. Default: none, and no edit page. |
| `extensions.form-records.config.records.*.editTitle` | string | no | minLength: 1; maxLength: 512 | Title of the edit page. Default: the form's title. |
| `extensions.form-records.config.records.*.list` | object | no | unknown keys rejected | Adds a page at `<mount>/` listing the signed-in user's own records (paginated; needs ui). Default: no list page. |
| `extensions.form-records.config.records.*.list.title` | string | no | minLength: 1; maxLength: 512 | Title of the list page. Default: Your records. |
| `extensions.form-records.config.records.*.list.columns` | array | yes | minItems: 1; maxItems: 8; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Form fields shown as columns, in this order. |

### Authoring surfaces and limits

Save a declared form into an owned store collection: a submission creates a record private to its signed-in creator, the confirmation page reads the saved record back, and an edit page changes only the fields listed in `editable`. forms keeps rendering, CSRF and validation; the store keeps ownership, limits and ETags. No handler code.

- **records** (configuration, `urlcode.yaml#extensions.form-records.config.records`): Each record flow: `mount`, the owned store `collection`, the `form` (a forms flow without a mount: title, submitLabel, confirmation with `show`, optional `success` (`{mode: inline, status: 200\|201}` answers a create or edit with the saved record's confirmation instead of a 303 to `<mount>/<id>`; an edit is always 200), fields), the optional `fields` map from form field to collection field, `editable` form fields, `editTitle` and an optional `list` page (`title`, `columns` of form fields).
- **mount** (extension, `urlcode.yaml`): Mount each record flow as `<mount>/*` with GET, HEAD and POST and a principal-providing policy such as `auth: true` (forms verifies its own CSRF token, which a plain HTML form posts in the body). It serves `<mount>` (new record), `<mount>/<id>` (confirmation), `<mount>/<id>/edit` and, with `list`, `<mount>/` (the caller's own records).

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
