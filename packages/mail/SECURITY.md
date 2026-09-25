# Security boundary

`mail` is trusted operator code that runs in the host process. It is not a sandbox or a multi-tenant boundary.
Project configuration can choose a default locale and name copy files inside the site; it cannot select a
module, a transport, a secret, a sender or a recipient address.

An operator-reviewed project revision (which `composeHost` in the site's `host.mjs` takes from the `--policy` file
or `PROJECT_SHA256` and passes to `host()` as `context.projectSha256`) is required; mail refuses to register
without it, the same as every other package under `packages/`.

## What mail keeps

| Property | How |
|---|---|
| No credential in a security notice | Notice templates declare only `page-link` slots, and a `page-link` value with a query or fragment is refused. |
| Links point at the site | Every link slot must be the canonical serialization of a URL on the canonical activation origin, with no userinfo. Alias origins are refused. Activation refuses an origin that is not HTTPS, except http on loopback. |
| No header injection | Plain text only. Subjects are static (no slots) and contain no control characters. The recipient is one mailbox with no whitespace, control characters, `,` or `;`. The sender is validated the same way in `host()`. |
| Bounded delivery | One global `maxConcurrent` (default 8; `busy` at once when full; a slot is held until the transport settles, so a transport that ignores the abort still counts), a per-message deadline (default 5 s) that aborts the transport, and SES at most two attempts. |
| Development output stays private | The outbox and console transports are refused off the node target. The outbox directory must be private (no group or other bits except on Windows), outside the route project after symlinks are resolved, and capped by count; each file is created exclusively with mode 0600 and synced. |
| The default is not a production sender | With no transport, mail writes to `<site>/data/outbox` only on a loopback origin on node. On any other origin delivery is off until host.mjs names a transport. |
| Secrets are never logged | mail logs nothing. A `MailError` message is a fixed string per code plus the template key, never an address or a value; a transport's own error is attached as `cause`, which the caller must not echo. |
| A namespace belongs to its contributor | core stamps every contribution with the contributing extension's registered name (`from`), which the contributed value cannot set. `host()` refuses a mail namespace that differs from its contributor's name, naming both, so one extension cannot contribute, replace or shadow another's templates. |
| Copy stays inside the site | Copy files resolve against the site directory and must stay inside it after symlinks are resolved; they are size-bounded and keep every slot of the source template. |

## What mail does not do

- It does not decide who may receive what. Consumers (auth, forms) own account enumeration defenses, rate limits
  and whether a failed delivery is visible to the requester.
- It does not know which extension calls `send()`. `MailExports` is one shared object, so a consumer sending only
  templates in its own namespace is a documented rule, not an enforced one. Extensions are operator code.
- An outbox left in place on a loopback deployment holds messages, including account links, in plain files.

Passing tests does not establish independent security assessment, hostile multi-tenant readiness, production abuse
resistance, or delivery guarantees. Report suspected vulnerabilities through the repository's private reporting
channel described in the root SECURITY.md.
