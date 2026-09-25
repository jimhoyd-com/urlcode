# @jimhoyd/urlcode-abuse

Persistent, pseudonymous rate limits, failure backoff and challenge escalation for extensions.

Abuse is a programmatic primitive that other extensions call. It has no routes and no route policy. For a
declarative, per-instance request budget on a route, use core's `policies.throttle`. Use abuse when an extension
needs any of these:

- **Persistent budgets** that survive a restart: a fixed window per counted value, such as a client address, an
  email or a domain.
- **Failure backoff**: exponential blocking after repeated failures, such as wrong passwords.
- **Challenge escalation**: a human-verification widget once a budget passes a threshold.

The consumers are auth (`extensions.auth.config.abuse`) and forms (a flow's `abuse`). Installing abuse does nothing
until one of them declares budgets.

This extension is trusted operator code (not sandboxed) that runs in the host process, like every other package
under `packages/`. It is released with core and installed into a site with `urlcode extensions add abuse`.

## Declare it

`urlcode extensions add abuse` writes the configuration and a private key, `data/abuse.key` (32 random bytes,
mode 0600). It writes no routes.

```yaml
version: "1"
extensions:
  abuse:
    version: "1"
    config:
      maxKeys: 100000   # hard bound on stored counters, 1000..1000000
```

Declaring `extension: abuse` on a route is refused at startup. Abuse runs on the `node` target only; `aws` and
`vercel` are refused before serving.

## Host file

```js
// host.mjs (trusted operator code, outside the project)
import { composeHost } from '@jimhoyd/urlcode/host';
import abuse from '@jimhoyd/urlcode-abuse/extension';
import { createTurnstileChallenge } from '@jimhoyd/urlcode-abuse';
export default await composeHost(import.meta.url, [
  abuse({
    // Optional. Without it, a consumer that asks for challengeAfter refuses to activate.
    challenge: createTurnstileChallenge({ secret: process.env.TURNSTILE_SECRET, siteKey: '<site key>', hostname: 'example.com' }),
  }),
]);
```

`abuse({...})` options, all optional:

| Option | Default | Meaning |
|---|---|---|
| `database` | `<site>/data/abuse.sqlite` | The counter database. It is created mode 0600 and refused if it is not a private regular file. |
| `key` | bytes of `keyFile` | The 32-byte HMAC key. |
| `keyFile` | `data/abuse.key` | Relative to the site. A missing key, or one that is not exactly 32 bytes, refuses at host time. |
| `challenge` | none | An `AbuseChallengeProvider`. The verifier is host.mjs code, never YAML. |

## For extension authors: `AbuseExports` v1

Read it with `ctx.get('abuse')`. Declare abuse in `uses` so your extension still works without it, or in
`requires` if it cannot. Import types only from `@jimhoyd/urlcode-abuse`.

```ts
const abuse = ctx.get<AbuseExports | undefined>('abuse');
// At activation: refuse when you need abuse and it is missing or inactive.
if (!abuse?.active) throw new Error('flow abuse needs `urlcode extensions add abuse`');
const ns = abuse.namespace('forms');                     // your extension name
const client = ns.budget({ scope: 'client', limit: 5, windowMs: 3600000, challengeAfter: 3 });
// Per request:
const value = clientKey(request.client);                 // core: an IPv6 /64 counts as one client
if (value === undefined) return respond(503);             // no trusted client address
let admission;
try { admission = await ns.admit([{ budget: client, value }]); }
catch { return respond(503); }                            // never admit on a throw
if (!admission.allowed) return respond(admission.status, admission.status === 429 ? { 'retry-after': admission.retryAfterSeconds } : {});
if (admission.challengeRequired && !(await abuse.challenge!.verify({ token: fields.challengeToken, client: request.client, action: 'forms' })))
  return respond(403);
```

- **`namespace(name)`** takes a name matching `/^[a-z][a-z0-9-]{0,31}$/` and gives isolated counters. Before
  activation it throws `AbuseError(503, 'abuse_inactive')`.
- **`budget({scope, limit, windowMs, challengeAfter?})`** takes a scope matching `/^[a-z][a-z0-9-]{0,31}$/`,
  a `limit` of 1..100000, a `windowMs` of 1000..86400000, and a `challengeAfter` of 1..limit-1.
- **`admit(entries)`** takes 1..8 entries of budgets from the same namespace, with values of 1..1024
  characters. It runs as one transaction:
  - If any counter is at its limit, it answers `{allowed:false, status:429, retryAfterSeconds}` and nothing
    increments.
  - If the table is full, it answers `{allowed:false, status:503, code:'abuse_capacity'}`.
  - Otherwise every counter increments. The window is fixed from its first hit. `challengeRequired` is true when a
    count passes its `challengeAfter`.
- **`backoff({scope, threshold?, initialDelayMs?, maxDelayMs?, resetAfterMs?})`** has these bounds and
  defaults:

  | Field | Bounds | Default |
  |---|---|---|
  | `threshold` | 1..20 | 5 |
  | `initialDelayMs` | 100..60000 | 1000 |
  | `maxDelayMs` | initialDelayMs..86400000 | 900000 |
  | `resetAfterMs` | maxDelayMs..604800000 | 86400000 |

  - `check(value)` returns `{blocked, retryAfterSeconds}`.
  - `failure(value)` blocks for `min(maxDelayMs, initialDelayMs * 2^(count-threshold))` once `count >= threshold`.
  - `clear(value)` forgets the value.
- A scope is either a budget or a backoff within one namespace, never both.
- **`challenge`** is present only when the operator passed one.
  - `widget(action)` returns validated `{markup, csp, scripts}`. Put `markup` inside the form. Pass `scripts` and
    `csp` to the ui kit's `wrap`.
  - `verify({token, client, action})` never throws. Pass the raw `request.client` address, not a `clientKey`.
- **`honeypot`** provides `markup(field)` and `filled(value)`, for an extension without a honeypot of its own.
- Any storage failure rejects with `AbuseError(503, 'abuse_unavailable')`. Answer 503. Never admit on a throw.

## Challenge providers

`createTurnstileChallenge({secret, siteKey, hostname, fetch?, timeoutMs?})` is the built-in provider. It works as
follows:

- It posts to Cloudflare's fixed siteverify endpoint.
- It checks the verdict's hostname, freshness and action. The action is the caller's namespace.
- It bounds the response to 8 KiB.
- It never caches a verdict.

Any other provider implements `AbuseChallengeProvider` (`widget(action)` and `verify({token, client, action,
signal})`), and abuse wraps it with the following bounds:

- The token is 1..2048 characters with no control characters.
- The client is an IP address.
- At most 32 verifications are in flight. A provider that ignores the abort keeps its slot until it settles.
- There is a 5 s deadline, after which the verification is aborted.
- Only a strict `true` passes.
- Widget validation: every origin is `https:`, every script's origin is listed in `csp.script`, and markup is at
  most 2048 bytes.

## Operating it

- **Capacity.** Every add first sweeps up to 1000 expired rows, then refuses past `maxKeys`. A full table answers
  503 (`abuse_capacity`), and the consumer answers 503. Raise `maxKeys` or shorten windows.
- **Backup.** `data/abuse.sqlite` is optional to back up because the counters are protective, not a record. Losing
  `data/abuse.key` only resets the counters: the old rows can no longer be matched, and they expire.
- **Durability.** The database uses WAL with `synchronous=NORMAL`, so a power loss can drop the last increments.

Requires the matching `@jimhoyd/urlcode` core as a peer. Apache-2.0.
