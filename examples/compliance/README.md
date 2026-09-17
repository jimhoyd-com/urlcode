# Custom compliance rules

`rules.mjs` is an operator rules module for `urlcode audit --compliance-rules`.
It adds three rules (an approved redirect host list, a description on every
route, a reminder to declare the origin), disables the built-in expired-routes
notice and raises the security-headers rule to `high`. See
[docs/COMPLIANCE.md](../../docs/COMPLIANCE.md) for the contract.

Run it against the cookbook from the runtime checkout. The module must be an
absolute path outside the audited project:

```sh
node src/cli.js audit --project examples/cookbook \
  --compliance baseline --compliance-rules "$PWD/examples/compliance/rules.mjs" --compliance-warn
```

Without `--compliance-warn` the run exits 1: the override makes the cookbook's
routes without `policies.security` high findings. The report's `compliance`
section lists every finding with its rule, severity, route, message,
remediation and the standard it cites.
