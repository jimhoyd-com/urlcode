import { assert, ConfigError } from './errors.ts';
import { targets as knownTargets } from './policies.ts';
import type { HandlerResult } from './http-response.ts';
import type { PolicyRequest, TargetName, TestPlan } from './types.ts';
export type { PolicyRequest, TargetName, TestPlan } from './types.ts';
export type { HandlerResult, HeaderPair } from './http-response.ts';

// Operator-supplied host plugins. They are not part of the project format: an
// application passes them to startServer/createRuntime, so the YAML stays
// portable and the trust boundary stays with the operator. Same hook names as
// first-party policies, so both are tested through one seam.
//
//   { name, version, targets: ['node', …],
//     onActivate(runtime)?, onRequest(req)?, onResponse(req, result)?,
//     onError(req, error)?, onClose()? }
//
// onRequest may return a result to short-circuit; onResponse returns the
// result to send. No hook can reach the guest, extend a deadline or read
// bindings: the request object carries none of those.
/** What onActivate receives: the started runtime's public facts, never its handlers. */
export interface PluginRuntime { testPlan(): TestPlan; version: string; root: string; target: string }
export interface Plugin {
  name: string; version: string; targets: TargetName[];
  onActivate?(runtime: PluginRuntime): void | Promise<void>;
  onRequest?(request: PolicyRequest): HandlerResult | undefined | void | Promise<HandlerResult | undefined | void>;
  onResponse?(request: PolicyRequest, result: HandlerResult): HandlerResult | undefined | void | Promise<HandlerResult | undefined | void>;
  onError?(request: PolicyRequest, error: unknown): void | Promise<void>;
  onClose?(): void | Promise<void>;
}
const hookNames = ['onActivate','onRequest','onResponse','onError','onClose'] as const;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

export function validatePlugins(plugins: unknown = [], target: string = 'node'): Plugin[] {
  assert(Array.isArray(plugins) && plugins.length <= 32, 'Plugins must be an array of at most 32 entries');
  const seen = new Set<string>();
  for (const candidate of plugins as unknown[]) {
    assert(candidate && typeof candidate === 'object', 'Plugin must be an object');
    const plugin = candidate as Partial<Plugin>; // trust boundary: operator code, checked field by field
    assert(typeof plugin.name === 'string' && namePattern.test(plugin.name), 'Plugin name must be lowercase kebab-case');
    assert(!seen.has(plugin.name), `Duplicate plugin "${plugin.name}"`); seen.add(plugin.name);
    assert(typeof plugin.version === 'string' && plugin.version.length <= 64, `Plugin "${plugin.name}" needs a version string`);
    assert(Array.isArray(plugin.targets) && plugin.targets.every(t => (knownTargets as readonly string[]).includes(t)), `Plugin "${plugin.name}" must list its supported targets`);
    if (!(plugin.targets as string[]).includes(target)) throw new ConfigError(`Plugin "${plugin.name}" does not support the ${target} target`);
    for (const hook of hookNames) assert(plugin[hook] === undefined || typeof plugin[hook] === 'function', `Plugin "${plugin.name}" hook ${hook} must be a function`);
    assert(hookNames.some(hook => plugin[hook]), `Plugin "${plugin.name}" declares no hooks`);
  }
  return plugins as Plugin[]; // every entry was just checked
}

export async function activatePlugins(plugins: Plugin[], runtime: PluginRuntime): Promise<void> {
  for (const plugin of plugins) await plugin.onActivate?.(runtime);
}

export async function pluginsRequest(plugins: Plugin[], request: PolicyRequest): Promise<HandlerResult | undefined> {
  for (const plugin of plugins) {
    const early = await plugin.onRequest?.(request);
    if (early) return early;
  }
  return undefined;
}

// Reverse order, so the plugin that saw the request first sees the response last.
export async function pluginsResponse(plugins: Plugin[], request: PolicyRequest, result: HandlerResult): Promise<HandlerResult> {
  for (let i = plugins.length - 1; i >= 0; i--) result = (await plugins[i]!.onResponse?.(request, result)) ?? result;
  return result;
}

export async function pluginsError(plugins: Plugin[], request: PolicyRequest, error: unknown): Promise<void> {
  for (let i = plugins.length - 1; i >= 0; i--) { try { await plugins[i]!.onError?.(request, error); } catch { /* an observer cannot change the outcome */ } }
}

export async function closePlugins(plugins: Plugin[]): Promise<void> {
  for (let i = plugins.length - 1; i >= 0; i--) { try { await plugins[i]!.onClose?.(); } catch { /* best effort */ } }
}
