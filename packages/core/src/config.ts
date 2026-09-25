import { Worker } from 'node:worker_threads';
import { readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, visit, isAlias, isScalar, isMap, isSeq, isNode, LineCounter } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { assert, ConfigError } from './errors.ts';
import type { ErrorDetails } from './errors.ts';
import { reservedResponseHeaders } from './http-policy.ts';
import type { AuthoredRouteConfig, FunctionConfig, LoadedDocument, MiddlewareConfig, ProjectDocument, RouteAuthShortForm, RouteConfig, SharedBlock } from './types.ts';

/** What config-worker.ts posts back: the loaded document, or the ConfigError message and details. */
export type ConfigWorkerResult = { value: LoadedDocument } | { error: string; details: ErrorDetails };
export interface ConfigWorkerData { project: string }

// The schema file is this package's own; JSON.parse gives unknown and Ajv takes it as a schema object.
const schema = JSON.parse(await readFile(new URL('../../../schemas/urlcode.schema.json', import.meta.url), 'utf8')) as object;
// Node hands the CJS module.exports (the class) to a default import; TypeScript types it as the namespace, whose .default is the same class.
const validate = new Ajv.default({ allErrors: false, verbose: true, strict: true, strictRequired: false, allowUnionTypes: true }).compile(schema);
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
/** Finds the 1-based line/column of the YAML node an RFC 6901 pointer names; with `key`, of that key in the named mapping. */
export type YamlLocator = (pointer: string, key?: string) => { line: number; column: number } | undefined;
const unescapePointer = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');
const pointerSegments = (pointer: string): string[] => pointer ? pointer.split('/').slice(1).map(unescapePointer) : [];
const escapePointer = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');
export function parseYaml(text: string): unknown {
  return parseYamlLocated(text).data;
}
/** `parseYaml` plus a locator that maps a schema failure back to its line. Syntax errors keep the parser's position. */
export function parseYamlLocated(text: string): { data: unknown; locate: YamlLocator } {
  assert(Buffer.byteLength(text) <= MAX_CONFIG_BYTES, 'Configuration exceeds 32 MiB');
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: false, strict: true, lineCounter });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    const start = problem.linePos?.[0];
    // Keep only the parser's fixed first sentence: the source excerpt it appends may hold a value.
    const reason = (problem.message.split(/ at line \d+|\n/)[0] ?? '').slice(0, 160);
    const where = start ? ` at line ${start.line}, column ${start.col}` : '';
    throw new ConfigError(`Invalid YAML${where}: ${reason} (${problem.code}); check indentation, quoting and brackets`, { code: 'invalid-yaml', line: start?.line, column: start?.col });
  }
  const at = (node: unknown): { line: number; column: number } | undefined => {
    const offset = isNode(node) ? node.range?.[0] : undefined;
    if (offset === undefined) return undefined;
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };
  visit(doc, (_key, node) => {
    assert(!isAlias(node) && !(isNode(node) && (node.anchor || node.tag)), 'YAML aliases, anchors and explicit tags are unsupported', { code: 'invalid-yaml', ...at(node) });
    if (isMap(node)) {
      // The parser's generic pair comparison is quadratic on large mappings.
      // Our string-only profile permits equivalent linear duplicate detection.
      const keys = new Set<string>();
      for (const pair of node.items) {
        assert(isScalar(pair.key) && typeof pair.key.value === 'string', 'YAML mapping keys must be strings', { code: 'invalid-yaml', ...at(pair.key) });
        assert(!keys.has(pair.key.value), `Duplicate YAML mapping key ${quoteKey(pair.key.value)}`, { code: 'duplicate-key', ...at(pair.key) });
        keys.add(pair.key.value);
      }
    }
    if (isScalar(node)) assert(node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value), 'Non-JSON YAML value', { code: 'invalid-yaml', ...at(node) });
  });
  const data: unknown = doc.toJS({ maxAliasCount: 0, mapAsMap: false });
  const inspect = (value: unknown, depth = 0): void => {
    assert(depth < 40, 'Configuration nesting exceeds 40 levels');
    if (typeof value === 'number') assert(Number.isFinite(value), 'Non-finite YAML number');
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assert(!['__proto__', 'prototype', 'constructor', '<<'].includes(key), 'Reserved mapping key');
        inspect(child, depth + 1);
      }
    }
  };
  inspect(data);
  const locate: YamlLocator = (pointer, key) => {
    let node: unknown = doc.contents, found: unknown = node;
    const path = pointerSegments(pointer);
    if (key !== undefined) path.push(key);
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find(item => isScalar(item.key) && item.key.value === segment);
        if (!pair) break;
        found = pair.key; node = pair.value;
      } else if (isSeq(node)) {
        const item = /^\d+$/.test(segment) ? node.items[Number(segment)] : undefined;
        if (!item) break;
        found = node = item;
      } else break;
    }
    return at(found);
  };
  return { data, locate };
}
const MAX_NAMED_KEY = 64;
const quoteKey = (key: string) => JSON.stringify(key.length > MAX_NAMED_KEY ? `${key.slice(0, MAX_NAMED_KEY)}...` : key);
const MAX_LISTED_KEYS = 10;
const editDistance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};
/** The allowed key an unknown key most likely meant: case-insensitive match, a prefix (3+ chars) either way, or edit distance <= 2. */
export function closestKey(key: string, allowed: string[]): string | undefined {
  if (key.length > MAX_NAMED_KEY) return undefined;
  const k = key.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of allowed) {
    const c = candidate.toLowerCase();
    const prefix = Math.min(k.length, c.length) >= 3 && (c.startsWith(k) || k.startsWith(c));
    const score = k === c ? 0 : Math.min(editDistance(k, c), prefix ? 2 : Infinity);
    if (score <= 2 && score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}
/** Detail fields for a failure about one route, optionally about one of its keys. */
const routeDetails = (pattern: string, key: string | undefined, code: string): ErrorDetails => ({ code, route: pattern, pointer: `/routes/${escapePointer(pattern)}`, key });
/** `; did you mean "x"?` or a bounded list of the allowed keys. */
function keyHint(key: string, allowed: string[]): string {
  const close = closestKey(key, allowed);
  if (close) return `; did you mean ${quoteKey(close)}?`;
  if (allowed.length > MAX_LISTED_KEYS) return `; allowed keys: ${allowed.slice(0, MAX_LISTED_KEYS).join(', ')}, ... (${allowed.length - MAX_LISTED_KEYS} more)`;
  if (allowed.length) return `; allowed keys: ${allowed.join(', ')}`;
  return '; no keys are allowed here';
}
/**
 * A pointer as a reader writes it: `/routes/~1a~1{id}/redirect` becomes `route /a/{id}, redirect`, so a route
 * path never appears JSON-pointer escaped. Other locations keep the pointer form.
 */
function describeLocation(pointer: string): string {
  const [first, pattern, ...rest] = pointerSegments(pointer);
  if (first === 'routes' && pattern !== undefined) return `route ${routeLabel(pattern)}${rest.length ? `, ${rest.join('.')}` : ''}`;
  return pointer || '/';
}
const MAX_ROUTE_LABEL = 200;
const routeLabel = (pattern: string): string => pattern.length > MAX_ROUTE_LABEL ? `${pattern.slice(0, MAX_ROUTE_LABEL)}...` : pattern;
const routeOf = (pointer: string): string | undefined => { const [first, pattern] = pointerSegments(pointer); return first === 'routes' ? pattern : undefined; };
const MAX_LISTED_VALUES = 16;
/** Schema-declared allowed values, never the author's value. */
const listValues = (values: unknown[]): string => values.length > MAX_LISTED_VALUES ? `${values.slice(0, MAX_LISTED_VALUES).map(v => JSON.stringify(v)).join(', ')}, ...` : values.map(v => JSON.stringify(v)).join(', ');
/**
 * One line for the first schema violation. Closed-key-set failures name the offending key and the keys the
 * schema allows, required failures name the missing key (and any unknown sibling that was probably meant for it),
 * and enum/const failures list the allowed values. Only key names, which come from the schema or the author's own
 * mapping keys, and values the schema itself declares are echoed, never the author's values (they may hold
 * secrets), and never more than MAX_NAMED_KEY characters of a key.
 */
function describeSchemaError(e: ErrorObject, scope?: { subject: string; pointer: string; shapeHint: string }): ConfigError {
  const pointer = (scope?.pointer ?? '') + e.instancePath;
  const base = `Invalid ${scope?.subject ?? 'configuration'} at ${scope && routeOf(pointer) === undefined ? boundedPointer(pointer) : describeLocation(pointer)} (${e.keyword})`;
  const parent = e.parentSchema as { properties?: Record<string, unknown>; additionalProperties?: unknown } | undefined;
  const details = { pointer, route: routeOf(pointer) };
  if (e.keyword === 'additionalProperties') {
    const key = String((e.params as { additionalProperty?: unknown }).additionalProperty);
    return new ConfigError(`${base}: unknown key ${quoteKey(key)}${keyHint(key, Object.keys(parent?.properties ?? {}))} (${scope?.shapeHint ?? 'run urlcode schema <path> for the shape'})`, { ...details, code: 'unknown-key', key });
  }
  if (e.keyword === 'required') {
    const missing = String((e.params as { missingProperty?: unknown }).missingProperty);
    const allowed = Object.keys(parent?.properties ?? {});
    // `redirect: {to: ...}` fails as a missing `url`; say what was found instead, since that is the actual mistake.
    const unknown = parent?.additionalProperties === false && e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? Object.keys(e.data).filter(key => !allowed.includes(key)) : [];
    const meant = unknown.find(key => closestKey(key, [missing]) !== undefined);
    let found = '';
    if (meant !== undefined) found = `; found unknown key ${quoteKey(meant)}, did you mean ${quoteKey(missing)}?`;
    else if (unknown.length) found = `; found unknown key ${quoteKey(unknown[0]!)} instead (allowed keys: ${allowed.slice(0, MAX_LISTED_KEYS).join(', ')}${allowed.length > MAX_LISTED_KEYS ? ', ...' : ''})`;
    return new ConfigError(`${base}: missing required key ${quoteKey(missing)}${found}`, { ...details, code: 'missing-key', key: meant ?? unknown[0] });
  }
  if (e.keyword === 'enum') return new ConfigError(`${base}: must be one of ${listValues((e.params as { allowedValues?: unknown[] }).allowedValues ?? [])}`, { ...details, code: 'invalid-value' });
  if (e.keyword === 'const') return new ConfigError(`${base}: must be ${JSON.stringify((e.params as { allowedValue?: unknown }).allowedValue)}`, { ...details, code: 'invalid-value' });
  // Ajv's own message is built from the schema (a type, a bound, a pattern), never from the value it rejected.
  return new ConfigError(e.message ? `${base}: ${e.message}` : base, { ...details, code: 'invalid-value' });
}
/** A failed branch whose value was simply the other branch's type: `auth: {...}` against `const: true`. */
const BRANCH_MISMATCH = new Set(['const', 'type', 'enum']);
const branchRank = (e: ErrorObject): number => (e.instancePath ? e.instancePath.split('/').length : 0) * 2 + (BRANCH_MISMATCH.has(e.keyword) ? 0 : 1);
/**
 * The violation to report. Ajv (with `allErrors: false`) ends the list with the failure that decided the result;
 * when that is a `oneOf`/`anyOf` no branch matched, the errors before it are the branches' own first failures, and
 * the first of them is usually the branch the value was never meant for (`auth: {roles: [...]}` failing
 * `const: true`). Report the deepest branch failure instead, preferring a real check over a bare type/const
 * mismatch at the same depth, so the message names the field that is wrong. A `oneOf` that matched more than one
 * branch is reported as itself.
 */
function selectSchemaError(errors: ErrorObject[]): ErrorObject | undefined {
  const decisive = errors[errors.length - 1];
  if (!decisive || !['oneOf', 'anyOf'].includes(decisive.keyword) || (decisive.params as { passingSchemas?: unknown }).passingSchemas) return errors[0];
  let best: ErrorObject | undefined;
  for (const e of errors.slice(0, -1)) {
    if (e.keyword === 'oneOf' || e.keyword === 'anyOf' || !e.instancePath.startsWith(decisive.instancePath)) continue;
    if (!best || branchRank(e) > branchRank(best)) best = e;
  }
  return best ?? errors[0];
}
const MAX_POINTER = 300;
/** A pointer capped for messages; the full pointer stays in the error details. */
const boundedPointer = (pointer: string): string => pointer.length > MAX_POINTER ? `${pointer.slice(0, MAX_POINTER)}...` : pointer;
/**
 * The first violation of an extension's own configuration schema, located under
 * `/extensions/<name>/config` and described like a core schema error: the failing pointer, the Ajv keyword and a
 * reason built from the schema, never the author's value. `errors` come from an Ajv validator compiled with
 * `verbose: true`, so a closed key set can suggest the key that was probably meant.
 */
export function extensionConfigError(name: string, errors: ErrorObject[] | null | undefined): ConfigError {
  const pointer = `/extensions/${escapePointer(name)}/config`;
  const first = selectSchemaError(errors ?? []);
  if (!first) return new ConfigError(`Invalid extension configuration at ${boundedPointer(pointer)}`, { code: 'invalid-value', pointer });
  return describeSchemaError(first, { subject: 'extension configuration', pointer, shapeHint: 'run urlcode extensions --json for its configuration schema' });
}
/**
 * The first violation of an extension's route policy schema, described like `extensionConfigError` and located
 * under `/routes/<route>/policies/extensions/<name>`, or under `/routes/<route>/<written>` when the author wrote the
 * policy through a route short form (`auth` for `auth:`, which core expands to `policies.extensions.auth`). The
 * policy checked is the route's effective one (project and profile layers merged with the route's own), so the
 * failing key may be written in one of those layers. Without `errors` the extension declares no policy schema and
 * accepts none.
 */
export function extensionPolicyError(name: string, route: string, errors: ErrorObject[] | null | undefined, written?: string): ConfigError {
  const pointer = `/routes/${escapePointer(route)}/${written === undefined ? `policies/extensions/${escapePointer(name)}` : escapePointer(written)}`;
  const first = errors ? selectSchemaError(errors) : undefined;
  if (!first) return new ConfigError(`Invalid extension policy at ${describeLocation(pointer)}: ${errors ? 'rejected by its policy schema' : `extension ${quoteKey(name)} declares no route policy`}`, { code: 'invalid-value', pointer, route });
  return describeSchemaError(first, { subject: 'extension policy', pointer, shapeHint: 'run urlcode extensions --json for its policy schema' });
}
const routeSchema = (schema as { $defs: { route: { properties: Record<string, unknown>; oneOf: { required: string[] }[] } } }).$defs.route;
const routeKeys = Object.keys(routeSchema.properties);
/** The handler keys, one of which every route declares: the schema's `oneOf` branches. */
const routeHandlerKeys: readonly string[] = routeSchema.oneOf.map(branch => branch.required[0]!);
/**
 * Route-level shape checked before the schema, because the schema's handler `oneOf` fails first and would report a
 * typo'd or duplicated handler as a missing `redirect`. Names the unknown key (with did-you-mean), or the handlers.
 */
function checkRouteShapes(data: unknown): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const routes = (data as { routes?: unknown }).routes;
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) return;
  for (const [pattern, route] of Object.entries(routes)) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) continue;
    const pointer = `/routes/${escapePointer(pattern)}`, where = `Invalid configuration at route ${routeLabel(pattern)}`;
    // `/users/:id` is Express/Next syntax: left alone it is a literal segment that never matches `/users/42`.
    const express = pattern.split('/').map(part => /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(part)?.[1]).find(name => name !== undefined);
    if (express !== undefined) throw new ConfigError(`${where}: segment :${express} is Express-style; write {${express}} and declare it under parameters: [{name: ${express}, in: path, required: true, schema: {type: string}}]`, { code: 'express-parameter', route: pattern, pointer });
    const unknown = Object.keys(route).find(key => !routeKeys.includes(key));
    if (unknown !== undefined) {
      throw new ConfigError(`${where} (additionalProperties): unknown key ${quoteKey(unknown)}${keyHint(unknown, routeKeys)} (run urlcode schema <path> for the shape)`, { code: 'unknown-key', route: pattern, pointer, key: unknown });
    }
    const handlers = routeHandlerKeys.filter(key => Object.hasOwn(route, key));
    if (handlers.length > 1) throw new ConfigError(`${where}: declares ${handlers.length} handlers (${handlers.join(', ')}); a route has exactly one. Keep one, split the behavior into two routes, or use conditional for request-dependent answers`, { code: 'multiple-handlers', route: pattern, pointer, key: handlers[1] });
    if (!handlers.length) throw new ConfigError(`${where}: declares no handler; add exactly one of: ${routeHandlerKeys.join(', ')}`, { code: 'no-handler', route: pattern, pointer });
  }
}
export function validateDocument(data: unknown, inherited?: Record<string, SharedBlock>): ProjectDocument {
  checkRouteShapes(data);
  if (!validate(data)) throw describeSchemaError(selectSchemaError(validate.errors!)!);
  const document = data as ProjectDocument; // trust boundary: the schema just admitted it
  for (const [name, block] of Object.entries(document.shared ?? {}))
    for (const header of Object.keys(block.response?.headers ?? {})) assert(!reservedResponseHeaders.has(header.toLowerCase()), `shared.${name}: response header ${header} is owned by the runtime or handler`);
  for (const [pattern, route] of Object.entries(document.routes)) document.routes[pattern] = expandShared(pattern, normalizeRoute(pattern, route), inherited ?? document.shared);
  return document;
}
/**
 * Resolves `use: <name>` at load time. The route's own `request` or `response` key wins as a whole block
 * (no deep merge); otherwise the shared block's key is copied in. `use` is removed, so the route hash,
 * audit and routes output show what actually applies. An unknown name fails validation.
 */
function expandShared(pattern: string, route: RouteConfig, shared: Record<string, SharedBlock> | undefined): RouteConfig {
  if (route.use === undefined) return route;
  const block = shared !== undefined && Object.hasOwn(shared, route.use) ? shared[route.use] : undefined;
  assert(block, `${pattern}: use references unknown shared block ${route.use}`, routeDetails(pattern, 'use', 'unknown-shared-block'));
  const { use: _use, ...rest } = route;
  const result: RouteConfig = { ...rest };
  if (rest.request === undefined && block.request !== undefined) result.request = structuredClone(block.request);
  if (rest.response === undefined && block.response !== undefined) result.response = structuredClone(block.response);
  return result;
}
/** The input declaration a short-form function gets for each `{param}` it does not declare itself. */
export const SHORT_FORM_PATH_SCHEMA = { type: 'string', minLength: 1, maxLength: 128 } as const;
// A short-form path is checked here, before the file system, so the error can name the route.
function modulePath(pattern: string, kind: 'function' | 'middleware', file: string): string {
  const relativePosix = !isAbsolute(file) && !/^(?:[A-Za-z]:|[\\/])/.test(file);
  const segments = file.split(/[\\/]/);
  assert(relativePosix && segments.every(s => s !== '..') && ['.mjs', '.js'].includes(extname(file)) && !file.endsWith('/') && !file.endsWith('\\'),
    `${pattern}: ${kind} short form must be a project-relative .mjs or .js path without .. segments`, routeDetails(pattern, kind, 'invalid-file-reference'));
  return file;
}
/**
 * Expands the YAML short forms into the canonical long form. `function: functions/x.mjs`
 * becomes `{source, args}` with an argument per `{param}` in the path, declaring any
 * parameter the route does not declare itself; a string middleware entry becomes `{source}`;
 * a route-level `cache` becomes `policies.cache` (refused alongside a direct `policies.cache`).
 * Everything downstream (routes, audit, the compiled table) sees only the long form.
 */
function normalizeRoute(pattern: string, route: AuthoredRouteConfig | RouteConfig): RouteConfig {
  const authored = route as AuthoredRouteConfig;
  const needsFunction = typeof authored.function === 'string';
  const needsMiddleware = authored.middleware?.some(entry => typeof entry === 'string') ?? false;
  const needsCache = authored.cache !== undefined;
  // Long form without `args`: bind every declared path input, exactly as the short form does, so `function: {source}`
  // is not silently handed an empty `args` (a route that wants none declares `args: {}`).
  const declaredPathNames = typeof authored.function === 'object' && authored.function !== null && authored.function.args === undefined
    ? (authored.parameters ?? []).filter(p => p.in === 'path').map(p => p.name) : [];
  const needsArgs = declaredPathNames.length > 0;
  if (!needsFunction && !needsMiddleware && !needsCache && !needsArgs) return route as RouteConfig;
  const result: RouteConfig = { ...(route as RouteConfig) };
  if (needsMiddleware) result.middleware = authored.middleware!.map((entry): MiddlewareConfig => typeof entry === 'string' ? { source: modulePath(pattern, 'middleware', entry) } : entry);
  if (needsFunction) {
    const source = modulePath(pattern, 'function', authored.function as string);
    const names = pattern.split('/').flatMap(part => { const match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(part); return match ? [match[1]!] : []; });
    const declared = authored.parameters ?? [];
    const parameters = [...declared, ...names.filter(name => !declared.some(p => p.in === 'path' && p.name === name)).map(name => ({ name, in: 'path' as const, required: true, schema: { ...SHORT_FORM_PATH_SCHEMA } }))];
    const expanded: FunctionConfig = { source, args: Object.fromEntries(names.map(name => [name, { from: 'path' as const, name }])) };
    if (parameters.length) result.parameters = parameters;
    result.function = expanded;
  }
  if (needsArgs) result.function = { ...(authored.function as FunctionConfig), args: Object.fromEntries(declaredPathNames.map(name => [name, { from: 'path' as const, name }])) };
  if (needsCache) {
    assert(result.policies?.cache === undefined, `Route ${pattern} declares both cache and policies.cache; use one form`, routeDetails(pattern, 'cache', 'conflicting-keys'));
    result.policies = { ...result.policies, cache: authored.cache! };
    delete result.cache;
  }
  return result;
}
export async function safeFile(root: string, file: unknown): Promise<string> {
  root = await realpath(root);
  assert(typeof file === 'string' && file.length && !isAbsolute(file), 'File reference must be project-relative', { code: 'invalid-file-reference' });
  // Naming the reference in the message helps an author fix a typo, but a reference that looks
  // like an escape attempt (contains a `..` segment) never gets named: the structured `file`
  // detail still carries it for the CLI's own terminal, but the text must not become an oracle
  // for what exists on the host outside the project (an MCP response is text only, mcp.ts).
  const suspicious = file.split(/[/\\]/).includes('..');
  const named = suspicious ? undefined : quotePath(file);
  const actual = await realpath(resolve(root, file)).catch(() => { throw new ConfigError(`Referenced project file is missing${named ? `: ${named}` : ''} (paths are relative to the directory holding urlcode.yaml)`, { code: 'missing-file', file }); });
  const rel = relative(root, actual);
  assert(rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel), `File reference escapes project${named ? `: ${named}` : ''}`, { code: 'invalid-file-reference', file });
  assert((await stat(actual)).isFile(), `Reference must point to a file${named ? `: ${named}` : ''}`, { code: 'invalid-file-reference', file });
  return actual;
}
/** An authored path for an error message: quoted and bounded, so it cannot run on or smuggle control characters. */
export const quotePath = (file: string): string => JSON.stringify(file.length > 200 ? `${file.slice(0, 200)}...` : file);
const MAX_PROJECT_CONFIG_BYTES = 64 * 1024 * 1024;
async function readConfig(file: string, budget: { remaining: number }): Promise<{ data: unknown; locate: YamlLocator }> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    assert(size <= MAX_CONFIG_BYTES, 'Configuration exceeds 32 MiB');
    assert(size <= budget.remaining, 'Project configuration exceeds aggregate 64 MiB');
    // Read at most the checked size plus one byte; concurrent growth cannot
    // turn a small stat result into an unbounded readFile allocation.
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.length-offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    assert(offset <= size, 'Configuration changed while reading');
    budget.remaining -= offset;
    return parseYamlLocated(new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(0,offset)));
  } finally { await handle.close(); }
}
/**
 * Reads, parses and checks one configuration file; a ConfigError from either step gains the file and, where the
 * failure has a pointer, its line and column, and its message is prefixed `file:line:column:` like a compiler's.
 */
async function located<T>(name: string, path: string, budget: { remaining: number }, check: (data: unknown) => T): Promise<T> {
  let locate: YamlLocator | undefined;
  try {
    const parsed = await readConfig(path, budget);
    locate = parsed.locate;
    return check(parsed.data);
  } catch (error) {
    if (!(error instanceof ConfigError) || error.details.file !== undefined) throw error;
    const details = error.details;
    details.file = name;
    if (details.line === undefined && details.pointer !== undefined && locate) {
      const position = locate(details.pointer, details.key);
      if (position) { details.line = position.line; details.column = position.column; }
    }
    const where = details.line === undefined ? name : `${name}:${details.line}${details.column === undefined ? '' : `:${details.column}`}`;
    const annotated = new ConfigError(`${where}: ${error.message.replace(/ at line \d+, column \d+/, "")}`, details);
    throw annotated;
  }
}
// Resource limits contain parser/AST/schema expansion, not just source bytes.
// The parent can terminate a blocked parser without blocking serving requests.
let activeLoads = 0;
export async function loadDocument(project: string, {timeoutMs=10000}: {timeoutMs?: number}={}): Promise<LoadedDocument> {
  assert(Number.isInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=30000, 'Configuration deadline must be 1–30000 ms');
  assert(activeLoads < 2, 'Configuration compilation capacity unavailable');
  activeLoads++;
  let worker: Worker | undefined;
  try {
    const data: ConfigWorkerData = {project};
    worker = new Worker(new URL('./config-worker.ts', import.meta.url), {
      workerData:data, env:{}, execArgv:[], stdout:true, stderr:true,
      resourceLimits:{maxOldGenerationSizeMb:256, maxYoungGenerationSizeMb:16, stackSizeMb:4},
    });
    worker.stdout.resume(); worker.stderr.resume();
    const started = worker;
    return await new Promise<LoadedDocument>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new ConfigError('Configuration compilation deadline exceeded')),timeoutMs);
      const done=(error: Error | null,value?: LoadedDocument)=>{clearTimeout(timer); if(error)reject(error);else resolve(value!);};
      // The worker only ever posts a ConfigWorkerResult (config-worker.ts).
      started.once('message',(message: ConfigWorkerResult)=>'error' in message ? done(new ConfigError(message.error, message.details)) : done(null,message.value));
      started.once('error',()=>done(new ConfigError('Configuration worker resource limit or failure')));
      started.once('exit',()=>done(new ConfigError('Configuration worker exited')));
    });
  } finally { try { await worker?.terminate(); } finally { activeLoads--; } }
}
/**
 * Expands the route-level `auth` short form into the canonical `policies.extensions.auth` requirement so every
 * downstream consumer (compiler, routes, audit, explain, revision hash) sees one form. `auth: true` is `{}`, and
 * `auth: {required: false}` documents intent and emits nothing. Core owns only this mapping: the requirement's keys
 * belong to the auth extension, whose `policySchema` validates them (`prepareExtensions`). Refuses routes that use
 * both forms or lack an `extensions.auth` declaration. Returns where each expansion came from, so a policy error
 * can name the `auth` key the author wrote.
 */
export function normalizeRouteAuth(document: Pick<ProjectDocument, 'extensions'>, routes: Record<string, RouteConfig>): Record<string, RouteAuthShortForm> {
  const origins: Record<string, RouteAuthShortForm> = Object.create(null) as Record<string, RouteAuthShortForm>;
  for (const [pattern, route] of Object.entries(routes)) {
    if (route.auth === undefined) continue;
    assert(document.extensions?.auth !== undefined, `Route ${pattern} declares auth but the project declares no extensions.auth`);
    const extensions = route.policies?.extensions;
    assert(extensions !== false, `Route ${pattern} declares auth alongside policies.extensions: false`);
    assert(!(extensions && Object.hasOwn(extensions, 'auth')), `Route ${pattern} declares both auth and policies.extensions.auth; use one form`);
    const { required = true, ...requirement } = route.auth === true ? {} : route.auth;
    delete route.auth;
    origins[pattern] = { required, requirement: structuredClone(requirement) };
    if (!required) continue;
    route.policies = { ...route.policies, extensions: { ...extensions, auth: requirement } };
  }
  return origins;
}
export async function loadDocumentInWorker(project: string): Promise<LoadedDocument> {
  const budget={remaining:MAX_PROJECT_CONFIG_BYTES};
  const root = await realpath(project).catch(() => {
    // A site's route project is app/ (see addon-install.ts); before `urlcode init` it is missing, and the next step
    // is init in the site directory, not in app/ itself (#542: `mcp print-config` registers app/ ahead of init).
    const absolute = resolve(project);
    if (basename(absolute) === 'app') throw new ConfigError(`No URLCode site at ${quotePath(dirname(absolute))} yet; run urlcode init ${quotePath(dirname(absolute))} to create the site and its app/ project, or pass --project <directory>`, { code: 'no-project' });
    throw new ConfigError(`Project directory not found: ${quotePath(project)}; pass an existing directory with --project`, { code: 'no-project' });
  });
  await lstat(resolve(root, 'urlcode.yaml')).catch(() => { throw new ConfigError(`No urlcode.yaml in ${quotePath(project)}; run urlcode init there to create a project, or pass --project <directory>`, { code: 'no-project', file: 'urlcode.yaml' }); });
  const file = await safeFile(root, 'urlcode.yaml');
  const document = await located('urlcode.yaml', file, budget, data => validateDocument(data));
  const routes: Record<string, RouteConfig> = Object.assign(Object.create(null) as Record<string, RouteConfig>, document.routes);
  const extensions = Object.assign(Object.create(null),document.extensions??{}) as NonNullable<ProjectDocument['extensions']>;
  const files = [file];
  let routeCount=Object.keys(routes).length;
  for (const include of document.includes || []) {
    const path = await safeFile(root, include);
    assert(!files.includes(path), 'Duplicate include');
    files.push(path);
    const part = await located(include, path, budget, data => validateDocument(data, document.shared ?? {}));
    assert(!part.includes?.length, 'Nested includes are unsupported');
    assert(part.site===undefined, 'site may only be set in the entry urlcode.yaml');
    assert(part.shared===undefined, 'shared may only be set in the entry urlcode.yaml');
    for(const [name,extension]of Object.entries(part.extensions??{})){assert(!Object.hasOwn(extensions,name),'Duplicate extension declaration across files');extensions[name]=extension;assert(Object.keys(extensions).length<=16,'Maximum 16 extensions per project');}
    for (const [pattern, route] of Object.entries(part.routes)) {
      assert(!Object.hasOwn(routes, pattern), 'Duplicate route across files');
      routes[pattern] = route;
      assert(++routeCount <= 100000, 'Maximum 100000 routes per project');
    }
  }
  if(Object.keys(extensions).length)document.extensions=extensions;
  const routeAuth = normalizeRouteAuth(document, routes);
  assert(Object.keys(routes).length <= 100000, 'Maximum 100000 routes per project');
  return { root, document, routes, files, ...(Object.keys(routeAuth).length ? { routeAuth: { ...routeAuth } } : {}), version: createHash('sha256').update(JSON.stringify(document.extensions?{routes,extensions:document.extensions,policies:document.policies,profiles:document.profiles,site:document.site}: document.site ? {routes, site:document.site} : routes)).digest('hex').slice(0, 16) };
}
export async function loadBindings(root: string, local = false, environment: Record<string, string | undefined> = process.env): Promise<Record<string, string | undefined>> {
  const vars: Record<string, string> = {};
  if (local) {
    try {
      const path = await safeFile(root, '.env.local');
      assert((await stat(path)).size <= 65536, '.env.local exceeds 64 KiB');
      const text = await readFile(path, 'utf8');
      // A deliberately small non-executable dotenv profile. No interpolation/escapes.
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        assert(match, 'Invalid .env.local assignment');
        const [, key = '', raw = ''] = match;
        assert(!Object.hasOwn(vars, key), 'Duplicate .env.local name');
        let value = raw.trim();
        if (value.startsWith('"') || value.startsWith("'")) {
          assert(value.length >= 2 && value.endsWith(value[0]!), 'Invalid .env.local quote');
          value = value.slice(1, -1);
        }
        vars[key] = value;
      }
    } catch (error) {
      // Only absence is optional. Malformed files and unsafe symlinks fail closed.
      try { await lstat(resolve(root, '.env.local')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...environment }; }
      throw error;
    }
  }
  return { ...vars, ...environment };
}
export async function functionFile(root: string, file: string): Promise<string> {
  assert(['.mjs', '.js'].includes(extname(file)), 'Functions must be JavaScript ES modules (.mjs or .js)');
  return safeFile(root, file);
}
