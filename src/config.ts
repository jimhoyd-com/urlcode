import { Worker } from 'node:worker_threads';
import { readFile, realpath, stat, lstat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, visit, isAlias, isScalar, isMap, isNode } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import { assert, ConfigError } from './errors.ts';
import type { LoadedDocument, ProjectDocument, RouteConfig } from './types.ts';

/** What config-worker.ts posts back: the loaded document, or the ConfigError message. */
export type ConfigWorkerResult = { value: LoadedDocument } | { error: string };
export interface ConfigWorkerData { project: string }

// The schema file is this package's own; JSON.parse gives unknown and Ajv takes it as a schema object.
const schema = JSON.parse(await readFile(new URL('../schemas/urlcode.schema.json', import.meta.url), 'utf8')) as object;
// Node hands the CJS module.exports (the class) to a default import; TypeScript types it as the namespace, whose .default is the same class.
const validate = new Ajv.default({ allErrors: false, strict: true, strictRequired: false, allowUnionTypes: true }).compile(schema);
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
export function validateDocument(data: unknown): ProjectDocument {
  if (!validate(data)) {
    const e = validate.errors![0]!;
    throw new ConfigError(`Invalid configuration at ${e.instancePath || '/'} (${e.keyword})`);
  }
  return data as ProjectDocument; // trust boundary: the schema just admitted it
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
export const MAX_PROJECT_CONFIG_BYTES = 64 * 1024 * 1024;
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
export async function loadDocumentInWorker(project: string): Promise<LoadedDocument> {
  const budget={remaining:MAX_PROJECT_CONFIG_BYTES};
  const root = await realpath(project);
  const file = await safeFile(root, 'urlcode.yaml');
  const document = validateDocument(await readConfig(file, budget));
  const routes: Record<string, RouteConfig> = Object.assign(Object.create(null) as Record<string, RouteConfig>, document.routes);
  const files = [file];
  let routeCount=Object.keys(routes).length;
  for (const include of document.includes || []) {
    const path = await safeFile(root, include);
    assert(!files.includes(path), 'Duplicate include');
    files.push(path);
    const part = validateDocument(await readConfig(path, budget));
    assert(!part.includes?.length, 'Nested includes are unsupported');
    assert(part.dynamicLinks===undefined, 'dynamicLinks may only be set in the entry urlcode.yaml');
    assert(part.site===undefined, 'site may only be set in the entry urlcode.yaml');
    for (const [pattern, route] of Object.entries(part.routes)) {
      assert(!Object.hasOwn(routes, pattern), 'Duplicate route across files');
      routes[pattern] = route;
      assert(++routeCount <= 100000, 'Maximum 100000 routes per project');
    }
  }
  assert(Object.keys(routes).length <= 100000, 'Maximum 100000 routes per project');
  assert(document.dynamicLinks===true || !Object.values(routes).some(route=>route.link), 'Link routes require dynamicLinks: true in urlcode.yaml');
  return { root, document, routes, files, version: createHash('sha256').update(JSON.stringify(document.site ? {...(document.dynamicLinks===true?{routes,dynamicLinks:true}:{routes}), site:document.site} : document.dynamicLinks===true?{routes,dynamicLinks:true}:routes)).digest('hex').slice(0, 16) };
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
