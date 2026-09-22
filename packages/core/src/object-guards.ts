// Small, dependency-free predicates shared across the runtime and its
// scripts. Kept separate from extension-transport.ts, which owns GitHub
// release/cache/lockfile plumbing (and imports Node-only modules) rather
// than generic object checks; router.ts and body-schema.ts reach this file
// instead so a Worker/edge bundle never pulls in Node builtins through it.

export type UnknownRecord = Record<string, unknown>;
/** True for a non-null, non-array object -- the shape most parsed JSON/YAML fields expect. */
export const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** True for a `key` that `object` itself declares (not inherited). */
export const own = (object: object, key: string): boolean => Object.hasOwn(object, key);

/** True when `error` is a Node `Error` carrying the given `code` (e.g. `'ENOENT'`). */
export const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
