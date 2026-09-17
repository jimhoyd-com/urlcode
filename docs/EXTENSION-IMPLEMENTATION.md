# Extension implementation sequence

PR #54 records the auth, admin, UI and extension direction. Implementation is
incremental; the spikes are proposals, not the implemented project schema.
The implemented specification remains authoritative. This sequence incorporates
the architectural review rather than treating contradictory spike examples as
requirements.

## Invariants

- Operators explicitly install trusted host extensions; project YAML never loads
  host modules or chooses packages. Application code remains isolated in WASM.
- Authentication credentials stay in host processing. Guest Request headers and
  header-derived parameters must not expose operator-declared credential headers,
  including on public routes receiving a session cookie.
- Session and one-time-token changes have explicit concurrency semantics. Define
  atomic operations before selecting a database abstraction; multi-record
  operations cannot rely on a same-collection transaction promise.
- Passwords and bearer credentials use appropriate hashes. TOTP requires protected
  recoverable key material and an operator key rotation/backup contract.
- Authentication forms and submission destinations belong to trusted extension
  code. Project styling does not imply permission to replace security controls.
- Administrative authorization is enforced by the API, including subject-level
  restrictions, self-promotion and last-administrator protections.
- Unsupported target capabilities fail explicitly. Live provider deployment
  testing remains deferred and non-blocking; local tests do not prove deployment.

## Delivery order

1. **Credential boundary:** add an explicit host-plugin declaration for headers
   withheld from guest requests and parameter resolution. Preserve originals for
   host authentication, cache decisions and policy processing. Test functions,
   middleware and routes without an authentication requirement.
2. **Extension registration:** explicit operator registry, versioned configuration
   validation, route ownership/collision rules and capability reporting. No
   automatic project host-file execution. Define policy ordering before adding
   an auth policy.
3. **Session slice:** one supported login method, trusted login/logout forms,
   protected page and JSON routes, session lookup/revocation, CSRF and no-store
   behavior. Evaluate a maintained authentication implementation behind an
   adapter before writing protocol engines. Define durable atomic store methods
   and test concurrent redemption, expiry and interrupted operations.
4. **Administrative API and CLI:** user lookup and session revocation first;
   audit records and narrowly scoped permissions. Add role/recovery operations
   only with object-level rules and concurrency tests.
5. **UI and console:** extract components from real auth/admin flows; choose a
   constrained renderer and asset ownership model; verify keyboard and assistive
   technology behavior as well as automated accessibility checks.
6. **Additional methods and targets:** passkeys, OIDC, MFA, recovery and imports
   each receive state-machine, abuse-budget and portability tests. Preserve
   verification of existing credential formats across target migrations.

## Status

PR #54 is merged. The first implementation adds the operator-only
`Plugin.credentialHeaders` boundary, documented in [Plugins](PLUGINS.md).
The generic versioned extension registry, revision pins, routes, authorization
ordering and explicit CLI host binding are implemented; see [Extensions](EXTENSIONS.md).
End-user auth and admin are developed in the separate `urlcode-auth` and
`urlcode-admin` repositories. The core does not own a general account database.

