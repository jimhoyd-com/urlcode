import { createRuntime } from './runtime.ts';
import { validatePolicy } from './policy.ts';
import { ConfigError } from './errors.ts';

// Handlers a stateless per-request invocation cannot honour. Functions and
// middleware need worker threads and the WASM engine on every cold start;
// stored links need a durable writable file that instances share. Adapters
// refuse them identically, so a project's supported surface does not depend on
// which provider is serving it.
const unsupported = { function:'isolated functions', link:'stored live links' };

export function readPolicyFromEnvironment(environment) {
  if (!environment.URLCODE_POLICY) return undefined;
  let parsed;
  try { parsed = JSON.parse(environment.URLCODE_POLICY); }
  catch { throw new ConfigError('URLCODE_POLICY is not valid JSON'); }
  // The same grant document the self-hosted runtime reads from a file, carried
  // through the only channel a managed platform has. Still revision-pinned.
  return validatePolicy(parsed);
}

// Activates a project for a native-handler-only host, refusing the whole
// deployment rather than letting individual routes fail at request time.
export async function activateNativeOnly(project, environment, { target = 'node', plugins } = {}) {
  const runtime = await createRuntime(project, { permissions: readPolicyFromEnvironment(environment), environment, target, plugins });
  const refused = runtime.testPlan().inventory.flatMap(route => [
    ...(unsupported[route.handler] ? [`${route.path} uses ${unsupported[route.handler]}`] : []),
    ...(route.middleware ? [`${route.path} declares middleware`] : []),
  ]);
  if (refused.length) {
    await runtime.close();
    throw new ConfigError(`This adapter serves native handlers only: ${refused.join('; ')}`);
  }
  return runtime;
}

// Caches a successful activation for the life of the instance. A failure is not
// cached, so a corrected deployment recovers without a code change.
export function lazyRuntime(activate) {
  let pending;
  return () => (pending ??= activate().catch(error => { pending = undefined; throw error; }));
}

export function resolveOrigin(origin, environment, platformVariables) {
  if (origin) return origin;
  if (environment.URLCODE_ORIGIN) return environment.URLCODE_ORIGIN;
  // Platform-set, not client-supplied: forwarded headers stay untrusted.
  for (const name of platformVariables) if (environment[name]) return `https://${environment[name]}`;
  return undefined;
}
