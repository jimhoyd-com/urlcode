# Provider conformance fixture

Deploy only this synthetic project to a disposable, operator-owned environment
using the documented self-hosted, AWS, Vercel or Cloudflare runtime adapter.
Never install it into a project containing private/customer routes or credentials.
The fixture has no function code, bindings, assets, policies or provider settings.
All redirect destinations use the reserved `example.test` domain; the verifier
never follows them. POST requests return constants and have no side effects.

See [provider verification](../../docs/PROVIDER-VERIFICATION.md) for the runner,
evidence format and limitations. CI replays the fixture through local adapters;
that does not establish that any provider deployment has been verified.
