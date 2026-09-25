# @jimhoyd/urlcode-mail

## Unreleased

First release. Plain-text transactional email as its own extension: `MailExports` v1, templates contributed by
other extensions through `contributes.mail` with checked slot kinds (`page-link`, `token-link`, `code`, `text`),
site copy files for overrides and translations, one operator transport (`sesTransport`, `outboxTransport`,
`consoleTransport`, `recordingTransport`), a per-message deadline and a global concurrency bound. With no transport,
messages go to `<site>/data/outbox` on a loopback origin only. The SES and development delivery code comes from
auth's senders, which it replaces.
