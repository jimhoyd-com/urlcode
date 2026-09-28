# @jimhoyd/urlcode-mail

## Unreleased

The definition declares its deployment targets (node, aws, vercel), which `npm run build:addons` writes into `urlcode.json` as `targets` (#859); core refuses a registration whose targets differ, and the capability preflight refuses a recipe or plan that uses this extension on any other target.

The delivery context follows the newest live activation (#777): a failed hot reload's close restores the serving activation's instead of leaving mail inactive, and in-flight deliveries are aborted only when no activation is left.

First release. Plain-text transactional email as its own extension: `MailExports` v1, templates contributed by
other extensions through `contributes.mail` with checked slot kinds (`page-link`, `token-link`, `code`, `text`),
site copy files for overrides and translations, one operator transport (`sesTransport`, `outboxTransport`,
`consoleTransport`, `recordingTransport`), a per-message deadline and a global concurrency bound. With no transport,
messages go to `<site>/data/outbox` on a loopback origin only. The SES and development delivery code comes from
auth's senders, which it replaces.

A mail namespace now belongs to its contributor (#753): core's `ctx.contributions('mail')` hands each value as `{from, value}` with the contributing extension's name stamped by core, and `host()` refuses a namespace that differs from it (`Mail namespace "<namespace>" is contributed by extension "<from>": an extension contributes mail templates only under its own name`). `createMail({contributions})` takes that stamped shape.
