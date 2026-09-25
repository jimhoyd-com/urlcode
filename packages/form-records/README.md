# @jimhoyd/urlcode-form-records

An operator-installed URLCode extension that saves a declared form into an
owned [store](../store/README.md) collection. A signed-in user submits the form,
the record is created as theirs, a confirmation page reads the saved record back,
and an edit page lets its owner change only the fields you list. Nothing else is
written by hand: no handler, no in-process map, no HTML.

It composes two other add-ons and owns only the composition:

- [forms](../forms/README.md) renders the form and keeps escaping, same-origin
  admission, body bounds, CSRF and field validation (403, 413, 415, and a 422
  page with field errors).
- [store](../store/README.md) keeps the record: per-record ownership, field
  validation, `maxRecords`, `maxRecordBytes` and strong ETags.

form-records never reads `extensions.forms.config` or `extensions.store.config`.
It reaches both through their typed exports, contract version 1 (`FormsExports`
and `StoreExports`, read with `ctx.get`), as the
[generic add-on authoring rules](../../docs/EXTENSIONS.md#generic-add-on-authoring-rules)
require. It is released with core, at core's version, and installed with
`urlcode extensions add form-records`, which also adds `forms`, `store` and `ui`
when the site lacks them.

## Declare a record flow

```yaml
extensions:
  ui: { version: "1", config: {} }
  auth: { version: "1", config: { … } }        # or any other principal provider
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
  form-records:                                # declared after forms and store
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
routes:
  /api/profiles/*: { extension: store, methods: [GET, HEAD, POST, PUT, PATCH, DELETE], auth: true }
  /onboarding/*: { extension: form-records, methods: [GET, HEAD, POST], auth: true }
```

| Key | Meaning |
| --- | --- |
| `records.<name>` | One record flow. The name is also the form's name in CSRF tokens (`^[a-z][a-z0-9-]{0,63}$`); at most 16. |
| `mount` | Where it is served; needs the route `<mount>/*` with `extension: form-records`, methods GET, HEAD and POST, and a principal-providing policy such as `auth: true`. |
| `collection` | A store collection declared with `ownership: owner` and not `readOnly`. |
| `form` | A forms flow body: `title`, `submitLabel`, `confirmation` (`title`, `message`, `show`), `fields`, optional `timeZone`. The same shape and rules as a flow under `extensions.forms.config.flows`, without `mount`. |
| `fields` | Form field to collection field. Optional: each form field defaults to the collection field of the same name. Every form field must be mapped, two form fields cannot fill one collection field, and every required collection field without a default must be filled. |
| `editable` | Form fields the edit page may change. Every other field is read-only after create. Empty or absent: no edit page. |
| `editTitle` | The edit page title. Default: the form's title. |

A form field fills a collection field of a matching type: a `checkbox` fills a
`boolean`, an input with `type: number` fills an `integer` or `number` (a
fraction for an `integer` is a 422 "must be a whole number"), and every other
control fills a `string`. Activation refuses any other pairing, as it refuses
every other problem above, with a message naming the record flow.

## What it serves

| Path | GET / HEAD | POST |
| --- | --- | --- |
| `<mount>` | The empty form | Create: 303 to `<mount>/<id>`, or the form again with errors |
| `<mount>/<id>` | The confirmation: the form's `confirmation` with its `show` fields read from the saved record, and an Edit link when `editable` is set | 405 |
| `<mount>/<id>/edit` | The editable fields pre-filled, the other fields as a read-only list | Partial update: 303 to `<mount>/<id>`, or the form again with errors |

- **Ownership.** Every request needs a principal; without one the answer is
  401 and nothing is read. A record another user created, and an id that does
  not exist, both answer 404, on the confirmation, the edit page and an edit
  submission alike: form-records passes the request principal to the store,
  which scopes every read and write.
- **Constrained updates.** The edit page renders and admits only the
  `editable` fields (through forms' `only()`); a submission that carries any
  other field is a 422 and changes nothing. The update sends only those fields
  (the store's partial update), so the rest of the record is unchanged. On the
  edit page an emptied optional text field is saved as empty text; an emptied
  optional number field is refused ("cannot be cleared once saved"), because
  the store cannot remove a field in a partial update.
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
submission creates or updates the record. There is no list page; the store's
JSON API (`GET <collection mount>`) lists the caller's own records.

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

In `host.mjs`, `composeHost` passes forms' and the store's exports to
`formRecords()`; it takes no operator options. Declare `forms` and `store`
before `form-records` under `extensions` (as `extensions add` does), so they
are active first; activation refuses otherwise.

## Targets

Node only. The store is Node-only (a single-writer file directory), so the
composition declares `targets: ['node']` and a build or runtime for `aws` or
`vercel` refuses it before serving.

## See also

- [SECURITY.md](SECURITY.md): the trust boundary.
- [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md): the extension contract, `ctx.get` and the request principal.
- [docs/FRAMEWORK.md](../../docs/FRAMEWORK.md): how the packages compose.

Apache-2.0.
