# @jimhoyd/urlcode-forms

`forms` is a trusted operator-installed extension for small server-rendered,
declarative form flows. It renders escaped fields through `urlcode-ui`, admits
only bounded URL-encoded POST bodies, validates declared fields, returns 422
with field errors, and answers a valid submission with a confirmation that
shows only the submitted fields the flow opts in to: by default a 303 redirect
to a confirmation page, or, with [`success: {mode: inline}`](#success-answer-redirect-or-inline),
the confirmation itself in the POST response. A flow may also declare a
submission budget ([`abuse`](#submission-budgets-abuse)) and a notification
email ([`notify`](#notifications-notify)). It is not a database or an
arbitrary template engine.

The extension requires the `ui` extension and an operator-provided CSRF secret,
and uses the `abuse` and `mail` extensions when they are installed.
Install it into a site with `urlcode extensions add forms` (which adds `ui` too
when the site lacks it). The scaffold writes an empty `flows` block, a random
CSRF secret at `data/forms-csrf.key`, and one line in `host.mjs`; add
`--example` for a sample `/contact` flow and route. The
secret and the reviewed project SHA live with the host, never in
`urlcode.yaml`:

```js
// host.mjs (trusted operator code, outside app/)
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '@jimhoyd/urlcode-ui/extension';
import forms from '@jimhoyd/urlcode-forms/extension';

export default await composeHost(import.meta.url, [
  ui(),
  forms(),   // or forms({ csrfSecretFile: '/etc/site/forms-csrf.key' }) or forms({ csrfSecret })
]);
```

`forms()` reads `data/forms-csrf.key` beside `host.mjs` by default; a relative
`csrfSecretFile` resolves against the site. The secret must be at least 32
bytes. `forms` receives the shared `ui` kit from the host. See
[add-ons](../../docs/EXTENSIONS.md#add-ons-extensions-and-artifacts) for the
site layout and commands.

Declare the UI and a form mount in the project. Add `auth: true` to compose
the flow with the auth extension; policy authorization (a signed-in session,
and same-origin provenance for the POST) runs before the form handler, which
still verifies its own CSRF token on every POST. The supplied `onSubmit` hook is trusted project code, runs only after
CSRF and field validation, and should make external effects idempotent.

```yaml
version: "1"
extensions:
  ui: {version: "1", config: {}}
  forms:
    version: "1"
    config:
      flows:
        contact:
          mount: /contact
          title: Contact us
          submitLabel: Send message
          confirmation: {title: Thank you, message: We received your message.}
          fields:
            email: {label: Email, type: email, required: true, maxLength: 320}
            topic: {label: Topic, control: select, required: true, options: [{value: support, label: Support}, {value: sales, label: Sales}]}
            message: {label: Message, control: textarea, required: true, minLength: 10, maxLength: 2000}
            terms: {label: I agree, control: checkbox, required: true}
routes:
  /assets/ui/*: {extension: ui}
  /contact/*: {extension: forms, methods: [GET, HEAD, POST]}
```

Fields are required unless `required: false` is declared. Supported server validations are `required`, string length, numeric bounds,
`email`, `date` (`YYYY-MM-DD`, a real calendar day), `datetime-local`
(`YYYY-MM-DDTHH:MM` with optional `:SS` and up to three fractional-second
digits, no timezone offset: the formats browsers submit for those input
types), a bounded safe `pattern` (only when `maxLength` is at most 128), string
`enum`, select options, the checkbox `true` value, and a one-level conditional
requirement (`requiredWhen`, below). Any other cross-field rule remains
application-specific and belongs in a reviewed `onSubmit` hook. No arbitrary
project HTML template is accepted.

A 422 page shows each error beside its field. An error the page cannot place
beside a field is listed in the page alert instead (#739): a declared field
the page does not render (an [`only()`](#using-a-flow-from-another-extension)
handle's other fields) by its label, for example "Name cannot be changed on
this form.", and any submitted name that is not a declared field as the fixed
"This form received a field it does not accept." The alert never repeats that
undeclared name or any submitted value.

### Conditionally required fields

`requiredWhen: {field, in}` makes a field required only when a sibling field in
the same flow was submitted with one of the listed values, and optional
otherwise:

```yaml
fields:
  kind: {label: Account type, control: select, options: [{value: personal, label: Personal}, {value: business, label: Business}, {value: charity, label: Charity}]}
  companyName: {label: Company name, maxLength: 200, requiredWhen: {field: kind, in: [business, charity]}}
```

When the condition holds, an empty field gets the same 422 `is required` error
as an unconditionally required field (a conditional checkbox must be checked).
When it does not, the field is optional. The field's other rules (length,
pattern, `enum`, type and bounds) apply whenever it has a value, whether or not
the condition holds. The requirement is enforced by the server only: the input
is not marked `required` in HTML and nothing is shown or hidden in the browser,
so say in the field's `description` when it becomes required.

Activation refuses a `requiredWhen` whose `field` is undeclared, is the field
itself, or is not a fixed-value field (a `select`, whose values are its
`options`, or an input with `enum`); an `in` value the sibling does not allow;
an empty or duplicated `in` (at most 128 values); a sibling that has its own
`requiredWhen` (conditions are one level only); and `requiredWhen` together
with `required`. Fields are required by default, so `requiredWhen` takes the
place of `required` rather than qualifying it.

Not supported, and still `onSubmit` territory: AND/OR combinations of
conditions, "not equal" and comparisons, conditions on free-text fields,
ordering between two fields (such as an end date after a start date), and
showing or hiding fields.

`minimum` and `maximum` bound a field's value, inclusive, in the field's own
format: a number for `type: number`, a `YYYY-MM-DD` date for `type: date`, and
a `YYYY-MM-DDTHH:MM` local date and time for `type: datetime-local`, or, for
the two date types, a bound relative to today (below). Either side may be
omitted. Date bounds are also rendered as the input's HTML `min`
and `max` attributes, so the browser's picker and its own validation agree
with the server; numeric bounds are enforced by the server only.

```yaml
fields:
  startDate: {label: Start date, type: date, minimum: "2026-01-01", maximum: "2027-12-31"}
  callback: {label: Callback time, type: datetime-local, required: false, minimum: "2026-01-05T09:00", maximum: "2026-01-09T17:30"}
```

Activation fails when a bound is not a real date or time in the field's
format, when `minimum` is later than `maximum`, or when a bound is set on a
field that is not `number`, `date` or `datetime-local`. A `datetime-local`
bound is whole minutes: browsers step a `datetime-local` input from its `min`,
so a bound with seconds would make the picker reject ordinary values. A
submitted value is compared at full precision, so with `maximum:
"2026-01-09T17:30"` the value `17:30:00` is accepted and `17:30:01` is not.

### Bounds relative to today

A `date` or `datetime-local` bound can also be `today`, or today moved by a
signed ISO 8601 duration of years, months and days:
`{from: today, add: <duration>}`. "Today" is the calendar date in the flow's
`timeZone`, an IANA name such as `Europe/London`, or in UTC when the flow
declares none. It never depends on the host's local zone, so the same YAML
behaves identically on node, aws and vercel.

```yaml
flows:
  signup:
    mount: /signup
    timeZone: Europe/London
    # title, submitLabel and confirmation as usual
    fields:
      birthDate: {label: Date of birth, type: date, maximum: {from: today, add: -P18Y}}
      startDate: {label: Start date, type: date, minimum: today, maximum: {from: today, add: P1Y6M}}
      callback: {label: Callback time, type: datetime-local, required: false, minimum: today, maximum: {from: today, add: P30D}}
      since: {label: Customer since, type: date, required: false, minimum: "2000-01-01", maximum: today}
```

- **Durations** are `P` followed by years, months and days in that order,
  each at most five digits, with an optional leading `-`: `P2Y`, `-P18Y`,
  `P30D`, `P1Y6M`, `P1M1D`. Weeks, time parts (`PT1H`), fractions and any
  expression are refused at activation, as are any other `from` than `today`
  and a zone name `Intl` does not know.
- **Month ends.** Years and months move first, clamping the day to the last
  day of the resulting month, then days move: from 31 January, `P1M` is
  28 February (29 in a leap year) and `P1M1D` is 1 March; from 29 February,
  `-P18Y` is 28 February, so someone born on 29 February is 18 on 1 March in
  a non-leap year. A result before `0001-01-01` or after `9999-12-31` is
  clamped to that date, which no submitted value can cross anyway.
- **`datetime-local`.** A relative `minimum` is 00:00 on its date. A relative
  `maximum` is the end of its date: it renders as `T23:59` and admits values up
  to 23:59:59.999 of that day, so `maximum: today` means "no later than
  today" rather than "before today started". The error message names the
  resolved bound (for example "must be on or before 2026-09-25T23:59").
- **Per request.** The server resolves today on every submission, and that
  check is authoritative. The rendered `min` and `max` attributes are
  computed when the page is served, as a convenience for the browser picker:
  a page left open across midnight in the flow's zone keeps yesterday's
  attributes until it is reloaded, and the server's answer can then differ
  from the browser's.
- **Order.** Activation refuses `minimum` later than `maximum` for two
  absolute bounds, and for two relative bounds when the window would be empty
  on any day (month-end clamping makes that date-dependent: `minimum: {from:
  today, add: P1M}` with `maximum: {from: today, add: P30D}` is refused). An
  absolute bound against a relative one is not compared at activation; once
  the relative side passes the absolute one, every value is refused with a 422.

## Handling a submission (`onSubmit`)

Without a hook, a valid submission only shows the confirmation. To do
something with it, name a trusted project module under
`extensions.forms.config.hooks.onSubmit`. The path is relative to the route
project (`app/`), like a function route's `source`; the bare string calls the
module's default export, and `{source, export}` names another export. One
hook serves every flow; `input.flow` says which one was submitted.

```yaml
version: "1"
extensions:
  ui: {version: "1", config: {}}
  forms:
    version: "1"
    config:
      hooks:
        onSubmit: hooks/on-submit.mjs   # or {source: hooks/on-submit.mjs, export: onSubmit}
      flows:
        contact:
          mount: /contact
          title: Contact us
          submitLabel: Send message
          confirmation: {title: Thank you, message: We received your message.}
          fields:
            email: {label: Email, type: email, maxLength: 320}
            topic: {label: Topic, control: select, options: [{value: support, label: Support}, {value: sales, label: Sales}]}
            message: {label: Message, control: textarea, minLength: 10, maxLength: 2000}
routes:
  /assets/ui/*: {extension: ui}
  /contact/*: {extension: forms, methods: [GET, HEAD, POST]}
```

```js
// app/hooks/on-submit.mjs: trusted project code, run in-process after CSRF and field validation.
import { appendFile, mkdir } from 'node:fs/promises';

const data = new URL('../../data/', import.meta.url); // the site's data/, outside app/

export default async function onSubmit({ flow, values }, { requestId }) {
  // values holds the declared fields only, validated, as strings keyed by field name.
  await mkdir(data, { recursive: true });
  await appendFile(new URL('form-submissions.jsonl', data), JSON.stringify({ flow, requestId, ...values }) + '\n');
}
```

The hook runs after CSRF admission, any `abuse` budget and field validation,
and before `notify` and the confirmation. It receives
`{flow, values}` (frozen) and a frozen context with the request id and the
mount route's granted `env`; its return value is ignored. If it throws, the
visitor gets a 500 page and no confirmation, and may submit again, so an effect
that must happen once needs its own idempotency. A missing module or export
fails activation, not the first request, and `sandbox: true` is refused. This
exact YAML and module run in the package tests (`test/readme-example.test.ts`).

## Showing submitted values on the confirmation

The confirmation page is fixed text unless the flow lists fields in
`confirmation.show`. Listed values are shown on the confirmation; the message
may place any of them inline as a `{field}` placeholder, and listed fields the
message does not reference follow as a label/value list. A checkbox reads
`Yes` or `No` and a select shows its option label. Fields not listed never
appear:

```yaml
confirmation:
  title: Thank you
  message: We will reply to {email} about {topic}.
  show: [email, topic]
```

Startup refuses a `show` entry that is not a declared field and a placeholder
whose field is not in `show`. A placeholder is `{` + a field name + `}`; other
braces are literal text. Every value is HTML-escaped, and placeholders are
substituted after the message is escaped, so a value can add neither markup
nor another placeholder.

The values travel from the submission to the confirmation in a sealed,
`HttpOnly` cookie that is encrypted, bound to the submitting browser and flow,
expires after 5 minutes, and is cleared when the confirmation is read, never
in the URL. See [SECURITY.md](SECURITY.md#confirmation-values) for the exact
guarantees. The confirmation falls back to its fixed form, with each
placeholder rendering as nothing, when that cookie is missing, expired,
tampered with, from another browser or flow, or already read: **refreshing the
confirmation shows the fixed form**. Word the message so it still reads well
that way. A handoff whose values exceed 2 KiB of JSON is not issued, so give
shown free-text fields a `maxLength` well under that. `HEAD` always answers
with the fixed form and leaves the cookie in place.

## Success answer: redirect or inline

By default a valid submission answers `303 See Other` to
`<mount>/confirmation` (redirect-after-POST), so a browser refresh re-requests
the confirmation rather than resubmitting the form. A flow can instead answer
with the confirmation itself (#805):

```yaml
version: "1"
extensions:
  ui: {version: "1", config: {}}
  forms:
    version: "1"
    config:
      flows:
        contact:
          mount: /contact
          title: Contact us
          submitLabel: Send message
          confirmation: {title: Thank you, message: "Thanks {name}, we will reply by email.", show: [name]}
          success: {mode: inline, status: 201}
          fields:
            name: {label: Name, maxLength: 120}
            email: {label: Email, type: email, maxLength: 320}
            message: {label: Message, control: textarea, minLength: 5, maxLength: 2000}
routes:
  /assets/ui/*: {extension: ui}
  /contact/*: {extension: forms, methods: [GET, HEAD, POST]}
```

| `success` | A valid POST answers |
|---|---|
| absent, or `{mode: redirect}` | `303` with `Location: <mount>/confirmation`; opted-in values travel in the sealed handoff cookie below |
| `{mode: inline}` or `{mode: inline, status: 200}` | `200` with the confirmation page as the body |
| `{mode: inline, status: 201}` | `201` with the confirmation page as the body |

- **Only the response changes.** Same-origin admission, the CSRF token and
  its binding cookie, the body bound, the abuse budget and challenge, field
  validation (422 with field errors), `onSubmit` and `notify` all run exactly
  as in redirect mode and in the same order, before any confirmation.
- **The page** is the flow's `confirmation`: its title, message and the
  `show` values, HTML-escaped with placeholders substituted after escaping,
  exactly as the redirect confirmation renders them. It is
  `Cache-Control: no-store`.
- **Nothing is carried forward.** Inline mode seals no handoff cookie and
  stores no submitted value: a fresh `GET <mount>` renders the empty form, and
  `<mount>/confirmation` only ever shows the fixed page.
- **A filled honeypot** gets the fixed confirmation (no submitted values) with
  the flow's status, as the redirect mode's silent 303 does.
- **Refresh resubmits.** A browser refresh of an inline confirmation offers to
  POST the form again, and a new token-bearing POST is a new submission, so
  keep `onSubmit` idempotent. Keep the default redirect unless a client needs
  the confirmation in the POST response.

Activation refuses `status` with `mode: redirect` (a redirect is always 303),
any `status` other than 200 or 201, any other `mode`, and unknown keys.

## Submission budgets (`abuse`)

With the [abuse extension](../abuse/README.md) installed and declared, a flow
may limit submissions per client and escalate to a challenge:

```yaml
flows:
  contact:
    mount: /contact
    abuse:
      client: {limit: 20, windowMs: 3600000}   # submissions per client (1..100000, 1 s..24 h)
      challengeAfter: 5                          # optional, below client.limit; needs abuse({challenge}) in host.mjs
      honeypot: website                          # optional hidden field name; must not be a declared field
    fields: {...}
```

A flow with `abuse` runs on the node target only; activation refuses it on aws
and vercel, and without an active abuse extension. Invalid submissions count
toward the budget. Over the limit the answer is the fixed `Too many
submissions` page (429) with `Retry-After`; when the abuse store cannot answer
it is `503 The form could not be submitted`, never an admitted submission. A
failed challenge re-renders the form (403) with `Complete the verification and
submit again.`; a filled honeypot gets a silent `303` to
`<mount>/confirmation` (with `success: {mode: inline}`, the fixed confirmation
inline with the flow's status) and nothing else happens. Budgets are keyed in abuse's
namespace `forms` with the scope `flow-` plus 24 hex characters of the flow
name's SHA-256, and the client key is core's `clientKey`. A flow defined by
another extension through `FormsExports` gets no abuse or notify.

## Notifications (`notify`)

With the [mail extension](../mail/README.md) installed, a flow may send one
plain-text notification per valid submission to an operator-named recipient:

```yaml
flows:
  contact:
    notify:
      recipient: support          # a name from mail({recipients: {support: 'support@site.example'}}) in host.mjs
      include: [email, topic]     # optional declared fields to list in the body
```

YAML names the recipient, never an address. Forms sends the `forms.submission`
message after `onSubmit` and before the confirmation; a delivery failure answers
503 with no confirmation, so delivery is at least once and the submitter can
retry. With no `include` the body says that no submitted values are included.
Each included value is capped at 1000 characters and the summary at 8000;
control characters are made safe for plain text. Change or translate the
message in `mail/copy/<locale>.json`.

## Using a flow from another extension

An extension that `requires: [forms]` can serve a form of its own through the
typed export forms hands it, `ctx.get('forms')` in its definition's `host()`
(`FormsExports`, contract version 1, #529). It never reads
`extensions.forms.config`; it declares the form in its own configuration,
embedding `formFlowBodySchema` (a flow without `mount`) in its schema:

```ts
const forms = context.get<FormsExports>('forms');   // in host()
// once forms is active (the runtime activates it before any extension that requires it):
const flow = forms.define('signup', body);           // same cross-field rules as a declared flow
flow.render(request, { action: '/signup', scope: 'my-extension:signup' });
const sent = flow.submit(request, { action: '/signup', scope: 'my-extension:signup' });
if (!sent.ok) return sent.response;                  // 403, 405, 413, 415 or the 422 page, as for forms' own flows
```

- `define(name, body)` validates the body exactly as forms validates a
  declared flow and throws an `Error` naming the problem; it refuses until
  forms is active.
- `render` and `submit` keep forms' escaping, same-origin admission, 64 KiB
  body bound, CSRF and field validation. The CSRF token also carries the
  page's `scope`: a token minted under one scope is refused under another, and
  a scoped token never admits a flow forms serves itself (nor the reverse).
- `only(names)` returns a handle that renders and admits only those fields; a
  submission carrying any other field is a 422. A `requiredWhen` field must
  keep its sibling. `readOnly` shows other declared fields' values as a list
  above the form, and `alert`, `title`, `submitLabel` and `status` adjust the
  page.
- `confirmationPage(values, {links, status})` renders the flow's confirmation
  from values the consumer supplies (for example a saved record), with
  optional same-site links; `status` is 200 (the default) or 201, for a
  confirmation answered inline to a POST. It is always `no-store`.
- `success` is the body's declared [success answer](#success-answer-redirect-or-inline)
  after defaults, `{mode: 'redirect', status: 303}` or
  `{mode: 'inline', status: 200 | 201}`. `define` refuses the same invalid
  combinations activation does. Forms does not act on it for an exported
  flow; the consumer honours it.

A flow defined this way has no mount and no `onSubmit` hook: the consumer
decides what a valid submission does. [form-records](../form-records/README.md)
is the first-party consumer.

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `forms` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** requires `ui` (`urlcode extensions add forms` installs them too); uses `abuse`, `mail` when installed (optional: the features that need one refuse to activate without it); contributes to `mail` (read only when that extension is installed).

### Configuration: `extensions.forms.config`

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.forms.config.flows` | object | yes | maxProperties: 16; keys: "^[a-z][a-z0-9-]{0,63}$" | Mounted form flows by name. Each needs a route `<mount>/*` with extension: forms (GET, HEAD, POST); a flow without its route, or a forms route without a flow, fails activation. |
| `extensions.forms.config.flows.*.mount` | string | yes | maxLength: 256; pattern: "^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$" | URL path the flow is served at: the form on GET and POST, the confirmation at `<mount>/confirmation`. |
| `extensions.forms.config.flows.*.title` | string | yes | minLength: 1; maxLength: 512 | Page heading and title of the form. |
| `extensions.forms.config.flows.*.timeZone` | string | no | pattern: "^[A-Za-z][A-Za-z0-9_+/-]{0,63}$" | IANA time zone (default UTC) that defines "today" for relative date bounds; refused at activation when unknown. |
| `extensions.forms.config.flows.*.submitLabel` | string | yes | minLength: 1; maxLength: 512 | Text of the submit button. |
| `extensions.forms.config.flows.*.confirmation` | object | yes | unknown keys rejected | The page a valid submission leads to. |
| `extensions.forms.config.flows.*.confirmation.title` | string | yes | minLength: 1; maxLength: 512 | Heading of the confirmation page. |
| `extensions.forms.config.flows.*.confirmation.message` | string | yes | minLength: 1; maxLength: 2048 | Confirmation text; a {field} placeholder is replaced by that submitted value (escaped) and must be listed in show. |
| `extensions.forms.config.flows.*.confirmation.show` | array | no | minItems: 1; maxItems: 32; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared fields whose submitted values the confirmation may display: carried in a sealed five-minute cookie on redirect, or rendered directly inline. Nothing else is echoed. |
| `extensions.forms.config.flows.*.success` | object | no | unknown keys rejected | What a valid POST answers: redirect (default) is a 303 to `<mount>/confirmation`; inline renders the confirmation in the POST response. |
| `extensions.forms.config.flows.*.success.mode` | string | yes | enum: ["redirect","inline"] | redirect or inline. |
| `extensions.forms.config.flows.*.success.status` | number | no | enum: [200,201] | Status of the inline confirmation (default 200); refused with mode redirect. |
| `extensions.forms.config.flows.*.fields` | object | yes | minProperties: 1; maxProperties: 32; keys: "^[a-z][A-Za-z0-9_]{0,63}$" | The form's fields in display order, keyed by field name (the submitted name). A field not declared here is refused. |
| `extensions.forms.config.flows.*.fields.*.label` | string | yes | minLength: 1; maxLength: 512 | Visible label of the field; also names it in error messages and on the confirmation. |
| `extensions.forms.config.flows.*.fields.*.control` | string | no | enum: ["input","textarea","select","checkbox"] | HTML control (default input). select needs options; checkbox takes no type or bounds and submits true or false. |
| `extensions.forms.config.flows.*.fields.*.type` | string | no | enum: ["text","email","number","tel","url","date","datetime-local"] | Input type for an input control (default text); decides which bounds apply and how the value is checked. |
| `extensions.forms.config.flows.*.fields.*.required` | boolean | no | — | Fields are required unless this is false. Not allowed together with requiredWhen. |
| `extensions.forms.config.flows.*.fields.*.minLength` | integer | no | minimum: 0; maximum: 65536 | Fewest characters a text value may have; not for number, date or checkbox fields. |
| `extensions.forms.config.flows.*.fields.*.maxLength` | integer | no | minimum: 1; maximum: 65536 | Most characters a text value may have; required (and bounded) when pattern is set. |
| `extensions.forms.config.flows.*.fields.*.minimum` | number / string / constant / object | no | one of: number; string (pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?$"); constant (const: "today"); object (fields below) | Lower bound: a number for type number; for date and datetime-local an absolute YYYY-MM-DD or YYYY-MM-DDTHH:MM value, today, or {from: today, add: `<duration>`} in the flow's timeZone. |
| `extensions.forms.config.flows.*.fields.*.minimum.from` | constant | yes | const: "today" | The flow's current date in its timeZone. |
| `extensions.forms.config.flows.*.fields.*.minimum.add` | string | yes | pattern: "^(-?)P(?=\\d)(?:(\\d{1,5})Y)?(?:(\\d{1,5})M)?(?:(\\d{1,5})D)?$" | Signed ISO 8601 period of years, months and days added to today, for example P30D or -P18Y. |
| `extensions.forms.config.flows.*.fields.*.maximum` | number / string / constant / object | no | one of: number; string (pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?$"); constant (const: "today"); object (fields below) | Upper bound, with the same forms as minimum; it must not be below minimum. |
| `extensions.forms.config.flows.*.fields.*.maximum.from` | constant | yes | const: "today" | The flow's current date in its timeZone. |
| `extensions.forms.config.flows.*.fields.*.maximum.add` | string | yes | pattern: "^(-?)P(?=\\d)(?:(\\d{1,5})Y)?(?:(\\d{1,5})M)?(?:(\\d{1,5})D)?$" | Signed ISO 8601 period of years, months and days added to today, for example P30D or -P18Y. |
| `extensions.forms.config.flows.*.fields.*.pattern` | string | no | minLength: 1; maxLength: 128 | Regular expression the whole text value must match; checked for catastrophic backtracking at activation and requires maxLength. |
| `extensions.forms.config.flows.*.fields.*.enum` | array | no | minItems: 1; maxItems: 128; uniqueItems: true; items: string (maxLength: 512) | Exact values an input accepts, or the subset of a select's option values it accepts. |
| `extensions.forms.config.flows.*.fields.*.description` | string | no | maxLength: 512 | Help text rendered under the field. |
| `extensions.forms.config.flows.*.fields.*.requiredWhen` | object | no | unknown keys rejected | Makes the field required only when a sibling select or enum field was submitted once with one of the listed values, and optional otherwise. Replaces required; the sibling must not itself be conditional. |
| `extensions.forms.config.flows.*.fields.*.requiredWhen.field` | string | yes | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | Name of the sibling field in this flow; it needs a fixed value set (a select or an enum input). |
| `extensions.forms.config.flows.*.fields.*.requiredWhen.in` | array | yes | minItems: 1; maxItems: 128; uniqueItems: true; items: string (maxLength: 512) | Values of the sibling that make this field required; each must be one the sibling accepts. |
| `extensions.forms.config.flows.*.fields.*.options` | array | no | minItems: 1; maxItems: 128 | Choices of a select control, in display order; only select fields take options. |
| `extensions.forms.config.flows.*.fields.*.options[].value` | string | yes | maxLength: 512 | Submitted value of the choice. |
| `extensions.forms.config.flows.*.fields.*.options[].label` | string | yes | maxLength: 512 | Visible text of the choice; the confirmation shows it for a shown select. |
| `extensions.forms.config.flows.*.abuse` | object | no | unknown keys rejected | Per-flow submission budget through the abuse extension (node target only); the flow refuses to activate without abuse installed. Needs the runtime trusted-proxy boundary to key clients. |
| `extensions.forms.config.flows.*.abuse.client` | object | yes | unknown keys rejected | Submissions admitted per client network (IPv4 address or IPv6 /64); over it a POST answers 429 with Retry-After. |
| `extensions.forms.config.flows.*.abuse.client.limit` | integer | yes | minimum: 1; maximum: 100000 | Submissions per window. |
| `extensions.forms.config.flows.*.abuse.client.windowMs` | integer | yes | minimum: 1000; maximum: 86400000 | Window length in milliseconds. |
| `extensions.forms.config.flows.*.abuse.challengeAfter` | integer | no | minimum: 1; maximum: 99999 | After this many admitted submissions in the window, a submission must pass the operator challenge (abuse({challenge}) in host.mjs); must be below client.limit. |
| `extensions.forms.config.flows.*.abuse.honeypot` | string | no | pattern: "^[a-z][A-Za-z0-9_]{0,63}$" | Name of a hidden field humans leave empty; a submission that fills it is answered as a success and dropped. Must not be a declared field. |
| `extensions.forms.config.flows.*.notify` | object | no | unknown keys rejected | Emails each accepted submission (template forms.submission) through the mail extension, after onSubmit and before the confirmation; the flow refuses to activate without mail. A failed delivery answers 503 and the visitor may resubmit, so delivery is at least once. |
| `extensions.forms.config.flows.*.notify.recipient` | string | yes | pattern: "^[a-z][a-z0-9-]{0,63}$" | Operator-named recipient from mail({recipients}) in host.mjs; an address never appears in YAML. |
| `extensions.forms.config.flows.*.notify.include` | array | no | minItems: 1; maxItems: 32; uniqueItems: true; items: string (pattern: "^[a-z][A-Za-z0-9_]{0,63}$") | Declared fields whose values the message carries as plain text (default none). |

### Project hooks: `extensions.forms.config.hooks`

Trusted project hooks by name ({source, export} or a bare module path). onSubmit runs for every flow; sandbox: true is refused.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.forms.config.hooks.onSubmit` | string / object | no | one of: string (minLength: 1; maxLength: 1024); object (fields below) | Action hook: Runs after the extension has admitted and validated a form submission, before the confirmation (a redirect, or the inline page with success.mode inline). It is trusted project code and receives only declared field values. |
| `extensions.forms.config.hooks.onSubmit.source` | string | yes | minLength: 1; maxLength: 1024 | Project-relative path of the trusted hook module, resolved like a function route source and re-imported on each activation. |
| `extensions.forms.config.hooks.onSubmit.export` | string | no | pattern: "^[A-Za-z_][A-Za-z0-9_]*$" | Named export to call (default: the module default export). |
| `extensions.forms.config.hooks.onSubmit.sandbox` | boolean | no | — | Schema-valid but refused at activation when true: extension hooks run trusted, in-process, and are never sandboxed. |
| `extensions.forms.config.hooks.onSubmit.sandboxReason` | string | no | minLength: 1; maxLength: 512 | Reviewer note recorded with a sandbox choice; it grants nothing. |

#### `onSubmit` (action)

Runs after the extension has admitted and validated a form submission, before the confirmation (a redirect, or the inline page with success.mode inline). It is trusted project code and receives only declared field values.

Called as `onSubmit(input, context)`; `context` carries `requestId` and the mount route's granted `env`, frozen.

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `input.flow` | string | yes | — | Name of the flow the submission belongs to (its key under flows). |
| `input.values` | object | yes | — | Validated values of the declared fields, as strings keyed by field name (a checkbox is true or false); frozen. |

Its return value is ignored.

### Authoring surfaces and limits

Declare a bounded server-rendered form flow with fixed fields and a confirmation page that can show opted-in submitted values (confirmation.show), reached by a 303 redirect or, with success.mode inline, rendered in the POST response (200 or 201). The forms extension owns HTML escaping, admission, CSRF and field validation; attach auth on the mount when submissions need a signed-in caller.

- **flows** (configuration, `urlcode.yaml#extensions.forms.config.flows`): Declare each mounted form, its bounded fields, explicit submit label and confirmation page.
- **success** (configuration, `urlcode.yaml#extensions.forms.config.flows.<name>.success`): Optional per-flow success answer: `success: {mode: redirect}` (the default) answers a valid POST with 303 to `<mount>/confirmation`; `success: {mode: inline, status: 200\|201}` renders the confirmation (title, message, opted-in `show` values, escaped) in the POST response itself, `no-store`, status 200 unless 201 is declared. `status` is refused with `mode: redirect`. CSRF, admission, validation (422) and onSubmit/notify ordering are the same in both modes.
- **abuse** (configuration, `urlcode.yaml#extensions.forms.config.flows.<name>.abuse`): Optional per-flow rate limit through the abuse extension (node only): `abuse: {client: {limit, windowMs}, challengeAfter?, honeypot?}`. Over the limit a POST gets 429 with Retry-After; above challengeAfter it must pass the operator's challenge (abuse({challenge}) in host.mjs); a filled honeypot field is accepted silently and dropped.
- **notify** (configuration, `urlcode.yaml#extensions.forms.config.flows.<name>.notify`): Optional per-flow email through the mail extension: `notify: {recipient, include?}` sends forms.submission to the operator-named recipient (mail({recipients}) in host.mjs) after onSubmit, with the include fields as plain text. A failed delivery answers 503 and the visitor may resubmit, so delivery is at least once.
- **onSubmit** (hook, `urlcode.yaml#extensions.forms.config.hooks.onSubmit`): Optional trusted project action, called only after successful form validation and CSRF admission. It is not sandboxed and must keep external effects idempotent.
- **mount** (extension, `urlcode.yaml`): Mount each flow as `/contact/*` with GET, HEAD and POST. Add `auth: true` when the form is for signed-in callers.

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
