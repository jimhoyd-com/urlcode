# @jimhoyd/urlcode-mail

Plain-text transactional email: templates contributed by other extensions, one operator transport.

mail serves no routes. Other extensions contribute named templates through `contributes: { mail: ... }` and send
them through the `MailExports` that `ctx.get('mail')` returns. The operator picks one delivery transport in
`host.mjs`. A project can change the wording or translate a message in a copy file, but it cannot name a recipient
address, a secret or a transport in YAML.

This extension is trusted operator code (not sandboxed) that runs in the host process, like every other package
under `packages/`. It is released with core and installed into a site with `urlcode extensions add mail`.

## Declare it

`urlcode extensions add mail` writes an empty `extensions.mail` block and the private `data/outbox/` directory
(`data/outbox/.keep`, mode 0600, in a 0700 directory). It writes no routes.

```yaml
version: "1"
extensions:
  mail:
    version: "1"
    config:
      defaultLocale: en            # optional; the contributed English source is the last fallback
      copy:                        # optional; locale -> site-relative JSON file
        fr: mail/copy/fr.json
```

A route with `extension: mail` is refused at activation: mail serves no routes.

## Choose delivery in host.mjs

```js
// host.mjs (trusted operator code, outside the project)
import { composeHost } from '@jimhoyd/urlcode/host';
import mail from '@jimhoyd/urlcode-mail/extension';
import { sesTransport } from '@jimhoyd/urlcode-mail';
export default await composeHost(import.meta.url, [
  mail({
    transport: sesTransport({ region: 'eu-west-1' }),
    from: 'no-reply@your.site',
    recipients: { support: 'support@your.site' },
  }),
]);
```

| Option | Meaning |
|---|---|
| `transport` | Omitted: on a loopback origin (`localhost`, `127.0.0.0/8`, `[::1]`) on the node target, messages are written to `<site>/data/outbox`. On any other origin delivery is off (`available: false`) until host.mjs names a transport. `null` turns delivery off everywhere. |
| `from` | The mailbox messages are sent from. Required for a non-development transport (`host()` throws `mail needs from`). Default for development transports: `no-reply@localhost`. |
| `recipients` | Operator-named addresses, for example `{support: 'support@your.site'}`. Consumers ask for a recipient by name (`mail.recipient('support')`), so a project YAML change alone can never redirect mail to an arbitrary address. At most 32; names match `^[a-z][a-z0-9-]{0,63}$`; each address is validated in `host()`. |
| `maxConcurrent` | Deliveries in flight across every consumer, 1 to 64, default 8. A delivery holds its slot until the transport settles, even after the caller has had `timeout` or `aborted`. When it is full, `send()` rejects `busy` (503) at once. There is no queue. |
| `deadlineMs` | Per-message deadline, 1000 to 30000 ms, default 5000. When it passes, `send()` rejects `timeout` (503) and the transport's signal is aborted. |

### Transports

| Transport | Target | Notes |
|---|---|---|
| `sesTransport({region, credentials?})` | node, aws, vercel | Amazon SES v2, plain text, one recipient, at most two SDK attempts. Needs the optional peer `@aws-sdk/client-sesv2`, loaded on first use; without it activation fails with `SES delivery requires the optional @aws-sdk/client-sesv2 package`. |
| `outboxTransport({directory, maxMessages?})` | node only | Development. `directory` is absolute, must already exist, be private (no group or other permission bits, except on Windows) and sit outside the route project. Each message is one exclusive 0600 `<uuid>.json` file holding `{development, template, to, from, subject, text, locale}`, at most 32768 bytes. At most `maxMessages` (1 to 1000, default 100) `.json` files, counted across restarts: after that sends fail visibly. An explicit outbox is honored on any origin on node. |
| `consoleTransport({write?, maxMessages?})` | node only | Development. One JSON line per message to `write` (default `console.log`), capped the same way. |
| `recordingTransport({max?})` | node only | In memory and bounded (default 100). For consumers' tests: `transport.sent` holds the envelopes. |

A transport is any object `{kind, development, prepare?, deliver(envelope, signal), close?}`. Development
transports are refused at activation on every target except node.

## Templates

A consumer contributes English source copy:

```ts
export default defineExtension({
  name: 'notifier', requires: ['mail'], targets: ['node'],
  contributes: { mail: { namespace: 'notifier', templates: {
    ping: { subject: 'Ping received', text: 'Someone pinged {page}.\n\nNote: {note}', slots: { page: 'page-link', note: 'text' } },
  } } },
  // host(ctx) { const mail = ctx.get<MailExports>('mail'); ... mail.send({template: 'notifier.ping', to, values}) }
});
```

- `namespace` must be the contributing extension's own name. `composeHost` stamps each contribution with the name of
  the extension that contributed it (`{from, value}`, which the value cannot override), and mail's `host()` refuses a
  namespace that differs from it: `Mail namespace "forms" is contributed by extension "notifier": an extension
  contributes mail templates only under its own name`. `composeHost` reports that as a `ConfigError` for extension
  `mail`. A consumer sends only templates in its own namespace (a documented rule: `send()` does not know its caller).
- Calling `createMail()` directly (outside `composeHost`), pass `contributions` in the same stamped shape:
  `[{ from: 'notifier', value: notifierMail }]`.
- At most 128 templates per namespace; keys match `^[a-z][a-z0-9-]{0,63}$`. The full name is `<namespace>.<key>`.
- `subject`: 1 to 160 characters, no control characters and no `{slots}`, so a value can never reach a header.
- `text`: plain text, 1 to 16384 characters, no control characters except newline and tab. Every `{slot}` in the
  text is declared in `slots`, and every declared slot appears. At most 8 slots.
- There is no HTML body.

### Slot kinds

Each value is checked against its slot's kind when it is sent. A failure is `invalid-values` (500).

| Kind | Accepts |
|---|---|
| `page-link` | The canonical serialization of an absolute URL on the canonical activation origin (alias origins are refused), with no userinfo, no query and no fragment; at most 2048 characters. Security notices use only this kind, so a credential cannot ride in a notice. |
| `token-link` | The same, but a query is allowed (it carries a credential); at most 4096 characters. |
| `code` | `^[A-Za-z0-9-]{4,64}$`. |
| `text` | At most 8192 characters, no control characters except newline and tab (`\r` is refused). |

The rendered text is at most 16384 characters.

### Who contributes what

| Namespace | Keys | Slots |
|---|---|---|
| `forms` | `submission` | `flow: text`, `summary: text` |

forms is the only first-party contributor; auth sends no mail (Better Auth owns accounts, and its email flows
are not included). The forms contribution lands with that package; this table is its contract with mail.

## Change the wording or translate

List a copy file per locale under `extensions.mail.config.copy`. Each file is a JSON object keyed by
`<namespace>.<key>`:

```json
{ "forms.submission": { "subject": "Nouvelle réponse au formulaire", "text": "Un visiteur a envoyé le formulaire « {flow} ».\n\n{summary}" } }
```

- Paths match `mail/copy/<name>.json`, resolve against the site directory (beside host.mjs) and must stay inside it
  after symlinks are resolved. Files are read once, at activation.
- Each file is at most 64 KiB and its entries total at most 65536 characters. Every key must be a contributed
  template, the `{slot}` set must be exactly the source's, and the subject and text bounds above apply.
- `copy.en` overrides the English source wording.
- Locale fallback: the exact tag, then its base language, then `defaultLocale` (default `en`), then the contributed
  English source. An invalid or unknown tag in a message falls back; it never throws.

## Send (consumers)

```ts
import type { MailExports } from '@jimhoyd/urlcode-mail';
const mail = ctx.get<MailExports>('mail');     // in host(); import types only
await mail.send({ template: 'notifier.ping', to: mail.recipient('support'), values: { page, note }, locale, signal });
```

- `active` is true once the runtime has activated mail. `available` is authoritative once active: it is false before
  activation, with `transport: null`, and when no transport was given and the origin is not loopback on node. A
  consumer reads it at its own activation (after mail's) or per call.
- `has(template)` and `recipient(name)` work at host time.
- `send()` resolves once the transport accepted the message. It refuses, in this order: `closed`, `unavailable`,
  `inactive`, `unknown-template`, `invalid-recipient`, `invalid-values`, `busy`, then an already-aborted `signal`
  (`aborted`). A transport failure is `delivery-failed` with the cause attached.
- `to` is one mailbox: at most 320 characters, exactly one `@`, no whitespace, control characters or any of
  `,;<>()[]"\`, a non-empty local part and a dotted or `localhost` domain. The domain is lower-cased.
- The caller's `signal` is combined with the deadline; either aborts the transport.

| `MailError.code` | `status` |
|---|---|
| `unavailable`, `inactive`, `busy`, `timeout`, `aborted`, `closed`, `delivery-failed` | 503 |
| `invalid-recipient` | 400 |
| `unknown-template`, `invalid-values`, `unknown-recipient` | 500 |

A `MailError` message is a fixed string per code plus the template key. It never holds an address or a value.

## Not implemented

HTML bodies, attachments, Reply-To, CC/BCC, several recipients, SMTP, queueing and retries beyond SES's
`maxAttempts: 2`, bounce or complaint handling. mail logs nothing.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.

<!-- extension-reference:start -->
<!-- Generated from urlcode.json by scripts/generate-extension-reference.ts (npm run docs:extensions). Do not edit between these markers; change the extension's schema descriptions instead. -->

## Field reference

Every key `mail` accepts, rendered from this package's `urlcode.json` (the schema the runtime validates against). Required means required within its containing object; `*` is a key you choose and `[]` an array item.

**Schema-valid is not activatable.** JSON Schema checks shape only. Activation also checks what a schema cannot express: the route for each declared mount exists, referenced fields and collections are declared, peers are installed and active, and the cross-field rules the descriptions state. A project that validates can still refuse to start; run `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, which activates it.

**Peers.** none.

### Configuration: `extensions.mail.config`

| Field | Type | Required | Schema constraints | Description |
|---|---|---|---|---|
| `extensions.mail.config.defaultLocale` | string | no | minLength: 2; maxLength: 35; pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$" | Language tag used when a message names no locale or one without copy (default en); the contributed English source is the last fallback. |
| `extensions.mail.config.copy` | object | no | maxProperties: 32; keys: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$"; values: string (maxLength: 256; pattern: "^mail/copy/[A-Za-z0-9_-]{1,64}\\.json$") | Site copy overrides by locale: each language tag maps to a `mail/copy/<name>.json` file (inside the site) that overrides or translates contributed templates by `<namespace>.<key>`, keeping every {slot}. Checked at activation. |

### Authoring surfaces and limits

Every email is a template another extension contributes. Change wording or translate in `mail/copy/<locale>.json`; choose delivery in host.mjs. Never put secrets or addresses in YAML.

- **defaultLocale** (configuration, `urlcode.yaml#extensions.mail.config.defaultLocale`): The locale used when a message names none or an unknown one; the contributed English source is the last fallback.
- **copy** (copy, `mail/copy/<locale>.json`): Override or translate a contributed template by its `<namespace>.<key>`; keep every {slot}. List each file under extensions.mail.config.copy.
- **transport** (extension, `host.mjs`): host.mjs mail({transport, from, recipients}).

Fast checks: `urlcode validate --project . --host-file <host.mjs> --origin <origin>`, `urlcode test --project . --host-file <host.mjs> --origin <origin>`.
<!-- extension-reference:end -->
