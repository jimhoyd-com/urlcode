# Trust-model decision

Project-authored `function` and `middleware` code is **trusted and unsandboxed
by default**. It runs directly in the Node host process with ordinary Node,
filesystem, network and npm access. This is an intentional product boundary,
not a sandbox escape or a claim that incoming requests are trusted.

Set `sandbox: true` on a route when the route's *code* needs isolation: for
example, it includes an unreviewed contribution, processes a third-party plugin,
or has a blast radius the project owner wants to contain. That route's complete
function/middleware chain runs in the QuickJS/WASM worker pool instead. It has
no Node, filesystem, shell, network, npm or ambient-process access. The
sandboxed execution path must never fall back to trusted execution.

## What does not change

- Request data is untrusted in both modes and must be validated.
- A binding grant controls only what URLCode injects into `context.env` and
  `context.secrets` (and, for an `extension:` mount's `env`, into
  `ExtensionRequest.env` and the hook context). It is revision-pinned and
  operator-approved. It is not a restriction on trusted code, which can
  independently use normal Node access.
- `sandbox: true` retains its isolated module graph, fresh invocation state and
  bounded guest resources. It is the appropriate boundary for code that the
  project cannot treat as first-party trusted code.
- Project extension hooks are trusted in-process in contract v1 and reject
  `sandbox: true`; they have a separate typed-hook contract.

## Upgrade and review rule

Projects upgrading from a revision where functions were sandboxed by default
must review every `function` and `middleware` route before deployment. Add
`sandbox: true` wherever the route's code is not fully trusted. A trusted route
needs no flag, but should be reviewed as ordinary deployed Node code.

The [function security guide](FUNCTION-SECURITY.md) is the complete public
security contract. [Capacity](CAPACITY.md) explains the distinct resource model
of the trusted and sandboxed paths. An independent assessment is still required
before offering the sandbox as a hostile multi-tenant boundary; see the
[sandbox review gate](SANDBOX-REVIEW.md). The detailed dated decision record and
implementation sweep are maintained privately and do not replace these public
contracts.
