// Public sandbox execution primitive: `@jimhoyd/urlcode/sandbox`.
//
// This is the same QuickJS/worker-thread engine that already backs
// `sandbox: true` `function`/`middleware` routes (src/functions.ts's
// `SandboxPool`, src/function-worker.ts, src/guest-api.ts) — there is exactly
// one place that owns worker spawning, dependency-closure module
// allowlisting, memory/stack limits and deadline enforcement. This module
// simply exposes that primitive under a route-independent shape, so an
// extension package (docs/EXTENSIONS.md's "Project-level lifecycle hooks")
// can run a project-supplied hook or middleware function through the same
// trusted/sandboxed dispatch selection route dispatch gets, when the
// project's own config declares `sandbox: true` on that hook.
//
// There is no "trusted" mode exported here, and there never will be: a hook
// that does NOT declare `sandbox: true` needs no primitive at all — it is
// ordinary first-party project code the extension can `import()` directly
// (see `ExtensionActivation.root` in src/extensions.ts). `SandboxPool` is
// specifically, and only, the isolated path. See
// docs/FUNCTION-SECURITY.md for why trusted execution needs no API.
//
// Every security property of the route-level sandbox applies unchanged here:
// a fresh QuickJS heap/module registry per invocation, no Node capability
// ever injected into the guest, the module-denial allowlist walk (only the
// entries this pool declares, and their own static-relative-import closure,
// are reachable — anything else, including a dynamic or unlisted relative
// import, is denied), a 32MB heap / 512KB stack ceiling per invocation, the
// deadline enforced twice (the QuickJS interrupt handler first, an outer
// worker-termination timeout as a hard backstop if the guest engine itself
// stops responding), `maxBytes` on both input and output, and strict
// validation of the guest's JSON response shape before any of it is trusted.
// None of these can be loosened from the outside; there is no option here to
// raise the memory/stack ceiling, add a module to the allowlist after
// construction, or pass a host object into the guest.
export { SandboxPool } from './functions.ts';
export type {
  SandboxEntry, SandboxTarget, SandboxInvocation, SandboxPoolOptions,
  FunctionContext, FunctionResult,
} from './functions.ts';
export type { GuestRequestPayload, GuestResponsePayload } from './guest-api.ts';
export type { HandlerResult, HeaderPair } from './http-response.ts';
/**
 * Resolves a project-relative hook source string the same way a native
 * `function`/`middleware` route's `source` is resolved (`.mjs`/`.js` only, no
 * path traversal outside the project root) into the absolute path
 * `SandboxPool`'s entries and `execute()` targets expect. `root` must be the
 * project's resolved directory (`ExtensionActivation.root`, never `cwd()`).
 */
export { functionFile } from './config.ts';
