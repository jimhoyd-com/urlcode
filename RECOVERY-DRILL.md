# Isolated synthetic backup and recovery drill

Run from a reviewed source checkout with its documented dependencies installed:

```sh
node --conditions=development scripts/recovery-drill.mjs
```

The source-only drill accepts **no arguments** and cannot be pointed at a live
database, project, key or account. It creates a private temporary directory,
generates synthetic credentials and keys in memory, and removes the complete
fixture after success or failure. No package CLI or production runtime API is
added. The JSON report includes only named checks and runtime versions. A failure
returns a nonzero exit code without serializing error objects or capabilities.

## What it exercises

The drill takes a consistent SQLite backup while an auth service remains open,
then demonstrates that the live service can still commit additional changes.
After closing that service, it restores the snapshot to a new isolated path and
checks persisted accounts, roles and password authentication. Wrong encryption
keys and changed role configuration are rejected before the restored service
accepts work. The correct restored configuration is opened, closed and reopened.
Private directory/file permissions are checked on platforms that enforce them.

The fixture deliberately revokes a session **after** taking its snapshot. That
session is valid in the restored snapshot: the later revocation was not backed
up. Accounts and sessions created after the snapshot are absent. These checks
make the recovery boundary visible rather than suggesting that restoring a
consistent database also restores the latest security state.

Finally the drill explicitly revokes every restored fixture account's sessions
through the existing operator service API, closes and reopens the restored
service, and confirms those cookies remain invalid. Password authentication still
works afterward. The fixture has exactly two snapshot accounts and asserts that
its account listing has no next page.

## Operator interpretation

Keep a real restored deployment isolated from traffic while reviewing its backup
age, provenance, matching configuration and separately stored key material. A real
revocation procedure must cover **every account page and all reusable capability
types**, including outstanding verification/reset/recovery flows, remembered-device
trust and provider state as applicable. This drill's session revocation does not
claim to invalidate every kind of token. Do not copy its bounded two-account
fixture enumeration into a production recovery procedure.

This is an executable regression drill for the local SQLite APIs. It does not
measure production RTO/RPO, simulate loss of the host or key custody, demonstrate
backup transport/offsite retention, restore external systems, exercise recovery
at production scale, or establish production disaster recovery readiness.

## Evidence

The initial local run passed all **18 checks** on Node 26.8.2 / SQLite 3.53.4.
The automated regression executes the complete drill and checks the redacted
report, plus refusal of caller-supplied paths. `npm run verify` reruns these checks
alongside the existing auth suite. Repeat on the operator's reviewed deployment
runtime; do not extrapolate a local result to an untested platform.
