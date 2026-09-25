# Security boundary

`abuse` is trusted operator code that runs in the host process. It is not a sandbox or a multi-tenant boundary.
Project configuration sets only `maxKeys`. It cannot select a module, a secret, a storage path or a challenge
provider: those come from host.mjs.

An operator-reviewed project revision (`context.projectSha256`, from the `--policy` file or `PROJECT_SHA256`) is
required. The extension refuses to register without one.

## What it guarantees

- **Pseudonymous keys.** Every counter key is
  `HMAC-SHA256(data/abuse.key, 'urlcode-abuse:v1\0' + namespace + '\0' + scope + '\0' + value)` in hex. A raw
  address, email or domain is never stored, returned or logged. A copied `abuse.sqlite` cannot be reversed by
  dictionary without the key.
- **A bounded table.** `abuse_counters` holds at most `maxKeys` rows (default 100000; 1000..1000000), and each
  claimed scope at most an equal share of them (`maxKeys` divided by the number of claimed `<namespace>/<scope>`
  pairs), so one consumer's unbounded, attacker-keyed growth cannot lock out another. Every operation that may add
  a row first sweeps up to 1000 expired rows, then refuses with 503 `abuse_capacity`. Each row records its
  `<namespace>/<scope>` names in plain text, never the counted value. Every statement is indexed.
- **Fail closed.** A storage failure rejects with `AbuseError(503, 'abuse_unavailable')`. The consumer contract is
  to answer 503 and never admit on a throw.
- **No partial admission.** `admit` checks every counter before incrementing any, inside one `BEGIN IMMEDIATE`
  transaction. A refused request increments nothing.
- **Private files.** The database is created mode 0600. It is refused if it is not a private regular file with one
  link. The scaffolded key is written mode 0600. SQLite builds without the fixes auth also requires are refused.
- **Bounded challenge verification.** The wrapper enforces these limits on any provider:
  - token shape;
  - an IP client;
  - at most 32 in flight;
  - a 5 s deadline with abort;
  - a strict `true`;
  - no cached verdicts.

  Widgets are validated before a page sees them: https origins only, every script's origin within `csp.script`,
  and markup of at most 2048 bytes.
- **Refusal before serving.** The registration targets `node` only, and a route that mounts `extension: abuse` is
  refused at activation.

## What it does not do

- **Counters are protective, not a record.** WAL with `synchronous=NORMAL` can lose the last increments on power
  loss.
- **A lost key resets every counter.** Old rows stop matching and expire.
- **The counters are per database file.** Several processes on one host share them through SQLite. Separate hosts
  with separate files do not.
- **Consumers own their semantics.** Abuse cannot tell whether a caller counts the right value, answers 503 on a
  throw, or verifies the challenge it asked for. Auth and forms carry their own tests for that.
- **The bounds are not a DDoS defense.** They limit per-value abuse inside an extension. Volumetric protection
  belongs in front of the process.

Passing tests does not establish independent security assessment, hostile multi-tenant readiness or production
abuse resistance. Report suspected vulnerabilities through the repository's private reporting channel described in
the root SECURITY.md.
