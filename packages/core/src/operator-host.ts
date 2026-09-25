import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, asConfigError, assert, hostLoadError } from './errors.ts';
import type { RuntimeOptions } from './runtime.ts';

/** Explicitly loaded operator code. Never discovered in application directories. */
export interface OperatorHost {
  extensions?: RuntimeOptions['extensions'];
  plugins?: RuntimeOptions['plugins'];
  close?(): void | Promise<void>;
}
/**
 * Where `composeHost` finds the revision pin the CLI derived from a verified `--policy` (#723). It is a
 * `Symbol.for` key so a host file that imports another copy of core reads the same value; it holds only the
 * policy's `projectSha256`, is set only while `loadOperatorHost` imports the host file, and no project file can set it.
 */
export const operatorRevisionKey = Symbol.for('urlcode.host.operatorRevision');
/** The pin `composeHost` uses: the verified policy revision when the CLI supplied one, otherwise `PROJECT_SHA256`; both set and different refuses. */
export function hostRevisionPin(): string {
  const fromPolicy = (globalThis as Record<symbol, unknown>)[operatorRevisionKey];
  const fromEnv = process.env.PROJECT_SHA256;
  if (typeof fromPolicy !== 'string') return fromEnv ?? '';
  assertRevisionsAgree(fromPolicy, fromEnv);
  return fromPolicy;
}
function assertRevisionsAgree(policy: string, env: string | undefined): void {
  if (env !== undefined && env !== '' && env !== policy) throw new ConfigError(`PROJECT_SHA256 (${env}) differs from the --policy revision (${policy}); with --policy the host is pinned to the policy's projectSha256, so unset PROJECT_SHA256 or set it to the same reviewed revision`, { code: 'revision-pin-mismatch' });
}
interface LoadOptions {
  /** The `projectSha256` of an operator policy the CLI already loaded and validated with `--policy`. */
  revision?: string | undefined;
}
export async function loadOperatorHost(given: string | undefined, project: string, { revision }: LoadOptions = {}): Promise<OperatorHost> {
  if (given === undefined) return {};
  // Always named explicitly; a relative name resolves against the working directory (a site's `--host-file host.mjs`).
  const file = resolve(given);
  assert(['.mjs', '.js'].includes(extname(file)), 'Host file must be an ES module path (.mjs or .js)');
  const root = await realpath(project), path = await realpath(file), rel = relative(root, path);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Host file must be outside the application project');
  const info = await stat(path);
  assert(info.isFile() && info.size <= 1048576, 'Host file must be a regular file of at most 1 MiB');
  let module: Record<string, unknown>;
  // Importing runs host.mjs, including composeHost and every extension's host() hook. Core's own refusals (and an
  // extension's, already named by composeHost) keep their message; anything else is reported as the host file's.
  if (revision !== undefined) assertRevisionsAgree(revision, process.env.PROJECT_SHA256);
  const slot = globalThis as Record<symbol, unknown>, previous = slot[operatorRevisionKey];
  if (revision !== undefined) slot[operatorRevisionKey] = revision;
  try { module = await import(pathToFileURL(path).href) as Record<string, unknown>; }
  catch (error) { throw asConfigError(error) ?? hostLoadError(error); }
  finally { if (previous === undefined) delete slot[operatorRevisionKey]; else slot[operatorRevisionKey] = previous; }
  const host: unknown = module.default;
  assert(host !== null && typeof host === 'object' && !Array.isArray(host), 'Host file must default-export an operator configuration object');
  assert(Object.keys(host).every(key => ['extensions', 'plugins', 'close'].includes(key)), 'Unknown operator host setting');
  const result = host as OperatorHost;
  assert(result.extensions === undefined || Array.isArray(result.extensions), 'Host extensions must be an array');
  assert(result.plugins === undefined || Array.isArray(result.plugins), 'Host plugins must be an array');
  assert(result.close === undefined || typeof result.close === 'function', 'Host close must be a function');
  return result;
}
