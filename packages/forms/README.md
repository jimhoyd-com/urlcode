# @jimhoyd/urlcode-forms

`forms` is a trusted operator-installed extension for small server-rendered,
declarative form flows. It renders escaped fields through `urlcode-ui`, admits
only bounded URL-encoded POST bodies, validates declared fields, returns 422
with field errors, and redirects a valid submission to a fixed confirmation
page. It is not a database, email sender, or arbitrary template engine.

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
`email`, a bounded safe `pattern` (only when `maxLength` is at most 128), string
`enum`, select options, and the checkbox `true` value. Conditional/cross-field
validation remains application-specific and belongs in a reviewed `onSubmit`
hook. No arbitrary project HTML template is accepted.

