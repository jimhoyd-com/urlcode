import { Worker } from 'node:worker_threads';
import { readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, visit, isAlias, isScalar, isMap, isNode } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { assert, ConfigError } from './errors.ts';
import { reservedResponseHeaders } from './http-policy.ts';
import type { AuthoredRouteConfig, FunctionConfig, LoadedDocument, MiddlewareConfig, ProjectDocument, RouteConfig, SharedBlock } from './types.ts';

/** What config-worker.ts posts back: the loaded document, or the ConfigError message. */
export type ConfigWorkerResult = { value: LoadedDocument } | { error: string };
export interface ConfigWorkerData { project: string }

// The schema file is this package's own; JSON.parse gives unknown and Ajv takes it as a schema object.
const schema = JSON.parse(await readFile(new URL('../schemas/urlcode.schema.json', import.meta.url), 'utf8')) as object;
// Node hands the CJS module.exports (the class) to a default import; TypeScript types it as the namespace, whose .default is the same class.
const validate = new Ajv.default({ allErrors: false, verbose: true, strict: true, strictRequired: false, allowUnionTypes: true }).compile(schema);
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
export function parseYaml(text: string): unknown {
  assert(Buffer.byteLength(text) <= MAX_CONFIG_BYTES, 'Configuration exceeds 32 MiB');
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: false, strict: true });
  assert(!doc.errors.length && !doc.warnings.length, 'Invalid YAML: check syntax, duplicate keys and tags');
  visit(doc, (_key, node) => {
    assert(!isAlias(node) && !(isNode(node) && (node.anchor || node.tag)), 'YAML aliases, anchors and explicit tags are unsupported');
    if (isMap(node)) {
      // The parser's generic pair comparison is quadratic on large mappings.
      // Our string-only profile permits equivalent linear duplicate detection.
      const keys = new Set<string>();
      for (const pair of node.items) {
        assert(isScalar(pair.key) && typeof pair.key.value === 'string', 'YAML mapping keys must be strings');
        assert(!keys.has(pair.key.value), 'Duplicate YAML mapping key');
        keys.add(pair.key.value);
      }
    }
    if (isScalar(node)) assert(node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value), 'Non-JSON YAML value');
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
  return data;
}
const MAX_NAMED_KEY = 64;
const quoteKey = (key: string) => JSON.stringify(key.length > MAX_NAMED_KEY ? `${key.slice(0, MAX_NAMED_KEY)}...` : key);
/**
 * One line for the first schema violation. Closed-key-set failures name the offending key and the keys the
 * schema allows, and required failures name the missing key, because a bare keyword sends the reader hunting.
 * Only key names, which come from the schema or the author's own mapping keys, are echoed, never values
 * (values may hold secrets), and never more than MAX_NAMED_KEY characters of a key.
 */
export function describeSchemaError(e: ErrorObject): string {
  const base = `Invalid configuration at ${e.instancePath || '/'} (${e.keyword})`;
  const parent = e.parentSchema as { properties?: Record<string, unknown> } | undefined;
  if (e.keyword === 'additionalProperties') {
    const key = String((e.params as { additionalProperty?: unknown }).additionalProperty);
    const allowed = Object.keys(parent?.properties ?? {});
    const list = allowed.length ? `; allowed keys: ${allowed.join(', ')}` : '; no keys are allowed here';
    return `${base}: unknown key ${quoteKey(key)}${list} (run urlcode schema <path> for the shape)`;
  }
  if (e.keyword === 'required') return `${base}: missing required key ${quoteKey(String((e.params as { missingProperty?: unknown }).missingProperty))}`;
  return base;
}
export function validateDocument(data: unknown, inherited?: Record<string, SharedBlock>): ProjectDocument {
  if (!validate(data)) {
    const e = validate.errors![0]!;
    throw new ConfigError(describeSchemaError(e));
  }
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
  assert(block, `${pattern}: use references unknown shared block ${route.use}`);
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
    `${pattern}: ${kind} short form must be a project-relative .mjs or .js path without .. segments`);
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
  if (!needsFunction && !needsMiddleware && !needsCache) return route as RouteConfig;
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
  if (needsCache) {
    assert(result.policies?.cache === undefined, `Route ${pattern} declares both cache and policies.cache; use one form`);
    result.policies = { ...result.policies, cache: authored.cache! };
    delete result.cache;
  }
  return result;
}
export async function safeFile(root: string, file: unknown): Promise<string> {
  root = await realpath(root);
  assert(typeof file === 'string' && file.length && !isAbsolute(file), 'File reference must be project-relative');
  const actual = await realpath(resolve(root, file)).catch(() => { throw new ConfigError('Referenced project file is missing'); });
  const rel = relative(root, actual);
  assert(rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel), 'File reference escapes project');
  assert((await stat(actual)).isFile(), 'Reference must point to a file');
  return actual;
}
const MAX_PROJECT_CONFIG_BYTES = 64 * 1024 * 1024;
async function readConfig(file: string, budget: { remaining: number }): Promise<unknown> {
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
    return parseYaml(new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(0,offset)));
  } finally { await handle.close(); }
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
      started.once('message',(message: ConfigWorkerResult)=>'error' in message ? done(new ConfigError(message.error)) : done(null,message.value));
      started.once('error',()=>done(new ConfigError('Configuration worker resource limit or failure')));
      started.once('exit',()=>done(new ConfigError('Configuration worker exited')));
    });
  } finally { try { await worker?.terminate(); } finally { activeLoads--; } }
}
/**
 * Expands the route-level `auth` short form into the canonical `policies.extensions.auth` requirement so every
 * downstream consumer (compiler, routes, audit, explain, revision hash) sees one form. `auth: {required: false}`
 * documents intent and emits nothing. Refuses routes that use both forms or lack an `extensions.auth` declaration.
 */
export function normalizeRouteAuth(document: Pick<ProjectDocument, 'extensions'>, routes: Record<string, RouteConfig>): void {
  for (const [pattern, route] of Object.entries(routes)) {
    if (route.auth === undefined) continue;
    assert(document.extensions?.auth !== undefined, `Route ${pattern} declares auth but the project declares no extensions.auth`);
    const extensions = route.policies?.extensions;
    assert(extensions !== false, `Route ${pattern} declares auth alongside policies.extensions: false`);
    assert(!(extensions && Object.hasOwn(extensions, 'auth')), `Route ${pattern} declares both auth and policies.extensions.auth; use one form`);
    const { required = true, ...requirement } = route.auth === true ? {} : route.auth;
    delete route.auth;
    if (!required) continue;
    route.policies = { ...route.policies, extensions: { ...extensions, auth: requirement } };
  }
}
export async function loadDocumentInWorker(project: string): Promise<LoadedDocument> {
  const budget={remaining:MAX_PROJECT_CONFIG_BYTES};
  const root = await realpath(project);
  const file = await safeFile(root, 'urlcode.yaml');
  const document = validateDocument(await readConfig(file, budget));
  const routes: Record<string, RouteConfig> = Object.assign(Object.create(null) as Record<string, RouteConfig>, document.routes);
  const extensions = Object.assign(Object.create(null),document.extensions??{}) as NonNullable<ProjectDocument['extensions']>;
  const files = [file];
  let routeCount=Object.keys(routes).length;
  for (const include of document.includes || []) {
    const path = await safeFile(root, include);
    assert(!files.includes(path), 'Duplicate include');
    files.push(path);
    const part = validateDocument(await readConfig(path, budget), document.shared ?? {});
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
  normalizeRouteAuth(document, routes);
  assert(Object.keys(routes).length <= 100000, 'Maximum 100000 routes per project');
  return { root, document, routes, files, version: createHash('sha256').update(JSON.stringify(document.extensions?{routes,extensions:document.extensions,policies:document.policies,profiles:document.profiles,site:document.site}: document.site ? {routes, site:document.site} : routes)).digest('hex').slice(0, 16) };
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
