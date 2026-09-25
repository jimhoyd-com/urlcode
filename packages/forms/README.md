# @jimhoyd/urlcode-forms

`forms` is a trusted operator-installed extension for small server-rendered,
declarative form flows. It renders escaped fields through `urlcode-ui`, admits
only bounded URL-encoded POST bodies, validates declared fields, returns 422
with field errors, and redirects a valid submission to a confirmation page that
shows only the submitted fields the flow opts in to. It is not a database, email sender, or arbitrary template engine.

The extension requires the `ui` extension and an operator-provided CSRF secret.
Install it into a site with `urlcode extensions add forms` (which adds `ui` too
when the site lacks it). The scaffold writes a sample `/contact` flow and route,
a random CSRF secret at `data/forms-csrf.key`, and one line in `host.mjs`. The
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
`enum`, select options, and the checkbox `true` value. Conditional/cross-field
validation remains application-specific and belongs in a reviewed `onSubmit`
hook. No arbitrary project HTML template is accepted.

`minimum` and `maximum` bound a field's value, inclusive, in the field's own
format: a number for `type: number`, a `YYYY-MM-DD` date for `type: date`, and
a `YYYY-MM-DDTHH:MM` local date and time for `type: datetime-local`. Either
side may be omitted. Date bounds are also rendered as the input's HTML `min`
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
Bounds are absolute; relative bounds such as "today" or "two years from now"
are not supported.

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

