import { readFile } from 'node:fs/promises';
import { assert } from './errors.ts';
import { isRecord } from './object-guards.ts';

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The version of the core package this code was loaded from (the repository root manifest in a checkout, the package manifest when installed). */
export async function runningCoreVersion(): Promise<string> {
  const raw: unknown = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert(isRecord(raw) && typeof raw.version === 'string' && versionPattern.test(raw.version), 'Could not read the running core version');
  return raw.version;
}
