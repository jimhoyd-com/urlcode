import type { RuntimeExtension } from './extensions.ts';
import { createRuntime } from './runtime.ts';
import type { HostPlugin, OperatorPolicy, Runtime } from './runtime.ts';
import { validatePolicy } from './policy.ts';
import { ConfigError } from './errors.ts';

/** The subset of process.env a hosted adapter reads. */
export type Environment = Record<string, string | undefined>;
interface NativeOnlyOptions { target: 'aws' | 'vercel'; plugins?: HostPlugin[] | undefined; extensions?:RuntimeExtension[]|undefined; origin?:string|undefined; aliasOrigins?:readonly string[]|undefined; passkeyRpId?:string|undefined }

export function readPolicyFromEnvironment(environment: Environment): OperatorPolicy | undefined {
  if (!environment.URLCODE_POLICY) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(environment.URLCODE_POLICY); }
  catch { throw new ConfigError('URLCODE_POLICY is not valid JSON'); }
  // The same grant document the self-hosted runtime reads from a file, carried
  // through the only channel a managed platform has. Still revision-pinned.
  return validatePolicy(parsed);
}

// Activates a project for a native-handler-only host, refusing the whole
// deployment rather than letting individual routes fail at request time.
export async function activateNativeOnly(project: string, environment: Environment, { target, plugins, extensions, origin, aliasOrigins, passkeyRpId }: NativeOnlyOptions): Promise<Runtime> {
  return createRuntime(project, { permissions: readPolicyFromEnvironment(environment), environment, target, plugins, extensions, origin, aliasOrigins, passkeyRpId });
}

// Caches a successful activation for the life of the instance. A failure is not
// cached, so a corrected deployment recovers without a code change.
export function lazyRuntime<T>(activate: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= activate().catch((error: unknown) => { pending = undefined; throw error; }));
}

export function resolveOrigin(origin: string | undefined, environment: Environment, platformVariables: string[]): string | undefined {
  if (origin) return origin;
  if (environment.URLCODE_ORIGIN) return environment.URLCODE_ORIGIN;
  // Platform-set, not client-supplied: forwarded headers stay untrusted.
  for (const name of platformVariables) if (environment[name]) return `https://${environment[name]}`;
  return undefined;
}

// The handler option wins; otherwise URLCODE_ALIAS_ORIGINS, a comma-separated
// list the operator sets beside URLCODE_ORIGIN. createRuntime validates both.
export function resolveAliasOrigins(aliasOrigins: readonly string[] | undefined, environment: Environment): readonly string[] | undefined {
  if (aliasOrigins !== undefined) return aliasOrigins;
  const listed = environment.URLCODE_ALIAS_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean);
  return listed?.length ? listed : undefined;
}

// The handler option wins; otherwise URLCODE_PASSKEY_RP_ID, which the operator
// sets beside URLCODE_ORIGIN and URLCODE_ALIAS_ORIGINS. createRuntime validates it.
export function resolvePasskeyRpId(passkeyRpId: string | undefined, environment: Environment): string | undefined {
  if (passkeyRpId !== undefined) return passkeyRpId;
  const value = environment.URLCODE_PASSKEY_RP_ID?.trim();
  return value ? value : undefined;
}
