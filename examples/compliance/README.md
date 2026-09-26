# Custom compliance rules

`rules.mjs` is an operator rules module for `urlcode audit --compliance-rules`.
It adds three rules (an approved redirect host list, a description on every
route, a reminder to declare the origin), disables the built-in expired-routes
notice and raises the security-headers rule to `high`. See
[docs/COMPLIANCE.md](../../docs/COMPLIANCE.md) for the contract.

Copy `rules.mjs` somewhere outside the project you audit (below,
`/operator/rules.mjs`; the module must be an absolute path outside the audited
project) and run it from that project, for example the cookbook copied with
`urlcode examples add cookbook --out cookbook`:

```sh
urlcode audit --project . --compliance baseline --compliance-rules /operator/rules.mjs --compliance-warn
```

Without `--compliance-warn` the cookbook run exits 1: the override makes its
routes without `policies.security` high findings. The report's `compliance`
section lists every finding with its rule, severity, route, message,
remediation and the standard it cites.
