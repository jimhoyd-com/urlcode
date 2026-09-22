import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './errors.ts';
import type { RuntimeOptions } from './runtime.ts';

/** Explicitly loaded operator code. Never discovered in application directories. */
export interface OperatorHost {
  extensions?: RuntimeOptions['extensions'];
  plugins?: RuntimeOptions['plugins'];
  close?(): void | Promise<void>;
}
export async function loadOperatorHost(file: string | undefined, project: string): Promise<OperatorHost> {
  if (file === undefined) return {};
  assert(isAbsolute(file) && ['.mjs', '.js'].includes(extname(file)), 'Host file must be an absolute ES module path (.mjs or .js)');
  const root = await realpath(project), path = await realpath(file), rel = relative(root, path);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Host file must be outside the application project');
  const info = await stat(path);
  assert(info.isFile() && info.size <= 1048576, 'Host file must be a regular file of at most 1 MiB');
  const module = await import(pathToFileURL(path).href) as Record<string, unknown>;
  const host: unknown = module.default;
  assert(host !== null && typeof host === 'object' && !Array.isArray(host), 'Host file must default-export an operator configuration object');
  assert(Object.keys(host).every(key => ['extensions', 'plugins', 'close'].includes(key)), 'Unknown operator host setting');
  const result = host as OperatorHost;
  assert(result.extensions === undefined || Array.isArray(result.extensions), 'Host extensions must be an array');
  assert(result.plugins === undefined || Array.isArray(result.plugins), 'Host plugins must be an array');
  assert(result.close === undefined || typeof result.close === 'function', 'Host close must be a function');
  return result;
}
