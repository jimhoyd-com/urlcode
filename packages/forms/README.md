# @jimhoyd/urlcode-forms

`forms` is a trusted operator-installed extension for small server-rendered,
declarative form flows. It renders escaped fields through `urlcode-ui`, admits
only bounded URL-encoded POST bodies, validates declared fields, returns 422
with field errors, and redirects a valid submission to a confirmation page that
shows only the submitted fields the flow opts in to. It is not a database, email sender, or arbitrary template engine.

The extension requires the `ui` extension and an operator-provided CSRF secret.
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
the flow with the auth extension; policy authorization runs before the form
handler. The supplied `onSubmit` hook is trusted project code, runs only after
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


## Using a flow from another extension

An extension that `requires: [forms]` can serve a form of its own through the
typed export forms hands it, `ctx.get('forms')` in its definition's `host()`
(`FormsExports`, contract version 1, #529). It never reads
`extensions.forms.config`; it declares the form in its own configuration,
embedding `formFlowBodySchema` (a flow without `mount`) in its schema:

```ts
const forms = context.get<FormsExports>('forms');   // in host()
// once forms is active (declare forms first under extensions):
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
- `confirmationPage(values, {links})` renders the flow's confirmation from
  values the consumer supplies (for example a saved record), with optional
  same-site links.

A flow defined this way has no mount and no `onSubmit` hook: the consumer
decides what a valid submission does. [form-records](../form-records/README.md)
is the first-party consumer.
