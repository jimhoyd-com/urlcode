# Contact form to a signal

`GET /` serves a static contact page. Its script (`public/assets/contact.js`)
posts the form to `POST /contact` as JSON. `/contact` answers
`202 {"accepted":true}` and then emits the declared signal to
`https://hooks.example.com/contact`. Replace that URL with an endpoint you own
before use.

There is no project code. `request.body.POST.schema` holds the field rules:

- `name`: 1 to 100 characters, with at least one non-space character.
- `email`: in the standard `email` format.
- `message`: 10 to 4000 characters.

The runtime answers 422 when a body breaks one of these rules, before `respond`
builds the reply. It also refuses a wrong method (405), a content type other
than `application/json` (415), a body larger than 16 KiB (413) and malformed
JSON (400). The 422 names the first failing field and never echoes what the
client sent ([HTTP](../../docs/HTTP.md#body-schema-and-input-patterns)
describes its format). Because the route takes JSON only, a cross-site HTML
form cannot submit to it.

Signals are self-hosted egress and need a revision-pinned operator grant. The
policy file must live outside the project:

```sh
urlcode permissions --project . > /operator/contact-policy.json   # review it
urlcode validate --local --project . --policy /operator/contact-policy.json
urlcode test --project . --policy /operator/contact-policy.json
urlcode audit --project . --expect-routes 3 --policy /operator/contact-policy.json
```

Without the grant, activation refuses the project. Editing any file changes the
project hash, so regenerate and re-review the policy afterwards.

A signal carries a fixed payload (route, method, status), not the submitted
message, and is best effort: drops are counted, never retried. See
[egress](../../docs/EGRESS.md).

`urlcode test` and `urlcode audit` send their fixtures as ordinary HTTP
requests. A fixture that reaches this route, such as the valid `POST` in
`tests/requests.json`, therefore calls the granted destination exactly as a
visitor would. Only `HEAD` requests and the runtime's internal readiness probes
skip the signal. Run the tests against a receiver you control. The policy can
only grant the origin that `urlcode.yaml` declares, and the transport refuses
loopback and private addresses, so a receiver on `localhost` cannot stand in.
Declare a public HTTPS test endpoint you own while you test, and generate and
review its own policy with `urlcode permissions`. Switch to the production URL
(and regenerate the policy) when you deploy. Each test call carries only the
route, method and status.

Throttle the route before you publish the page. `policies.throttle` limits
requests per client on this one route ([policies](../../docs/POLICIES.md)).

This recipe does not deliver or keep the message. Nothing downstream can
recover it either: request logs and events never carry a request body or field
value ([privacy guarantees](../../docs/OBSERVABILITY.md#privacy-guarantees)).
To keep messages, post the JSON to a [store](../../packages/store/README.md)
collection mount as well ([STORE](../../docs/STORE.md) says who may write to
one).

## Sending mail from your own code instead

To email each message, replace `respond` and `signals` on `/contact` with a
trusted `function` route and keep the body schema. The schema still runs before
the function, so the function only delivers. Call the mail provider directly,
through its SDK, its HTTP API or nodemailer, and pass the credentials as a
granted `secrets` binding such as `SMTP_URL: {secret: CONTACT_SMTP_URL}`:

```js
import nodemailer from 'nodemailer';

let transport;
export default async function contact(request, {secrets}) {
  const {name, email, message} = await request.json();
  transport ??= nodemailer.createTransport(secrets.SMTP_URL);
  await transport.sendMail({from: 'website@example.com', to: 'you@example.com', replyTo: email, subject: `Contact from ${name}`, text: message});
  return Response.json({accepted: true}, {status: 202});
}
```

Add the package to the site's `package.json`, and declare `sandboxReason` to
say why the route is trusted (the `webhook-receiver` recipe shows the shape).
