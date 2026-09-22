# Store schema artifact

This data-only artifact contains a reviewed snapshot of the configuration schema
and a minimal example for URLCode's `store` extension. It does not contain or
install executable code, activate an extension, or grant filesystem access.

Serving a store still requires a verified executable bundle, an explicit trusted
host-file registration, an operator-owned data directory outside the project,
and a pinned project revision. Check the supported bundle release guidance
because a newer runtime schema can differ from this immutable snapshot.
