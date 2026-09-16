import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, visit, isAlias, isScalar, isMap } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import { assert, ConfigError } from './errors.js';

const schema = JSON.parse(await readFile(new URL('../schemas/urlcode.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: false, strict: true, strictRequired: false, allowUnionTypes: true }).compile(schema);
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
export function parseYaml(text) {
  assert(Buffer.byteLength(text) <= MAX_CONFIG_BYTES, 'Configuration exceeds 32 MiB');
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: false, strict: true });
  assert(!doc.errors.length && !doc.warnings.length, 'Invalid YAML: check syntax, duplicate keys and tags');
  visit(doc, (_key, node) => {
    assert(!isAlias(node) && !node?.anchor && !node?.tag, 'YAML aliases, anchors and explicit tags are unsupported');
    if (isMap(node)) {
      // The parser's generic pair comparison is quadratic on large mappings.
      // Our string-only profile permits equivalent linear duplicate detection.
      const keys = new Set();
      for (const pair of node.items) {
        assert(isScalar(pair.key) && typeof pair.key.value === 'string', 'YAML mapping keys must be strings');
        assert(!keys.has(pair.key.value), 'Duplicate YAML mapping key');
        keys.add(pair.key.value);
      }
    }
    if (isScalar(node)) assert(node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value), 'Non-JSON YAML value');
  });
  const data = doc.toJS({ maxAliasCount: 0, mapAsMap: false });
  const inspect = (value, depth = 0) => {
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
export function validateDocument(data) {
  if (!validate(data)) {
    const e = validate.errors[0];
    throw new ConfigError(`Invalid configuration at ${e.instancePath || '/'} (${e.keyword})`);
  }
  return data;
}
export async function safeFile(root, file) {
  root = await realpath(root);
  assert(typeof file === 'string' && file.length && !isAbsolute(file), 'File reference must be project-relative');
  const actual = await realpath(resolve(root, file)).catch(() => { throw new ConfigError('Referenced project file is missing'); });
  const rel = relative(root, actual);
  assert(rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel), 'File reference escapes project');
  assert((await stat(actual)).isFile(), 'Reference must point to a file');
  return actual;
}
async function readConfig(file) {
  assert((await stat(file)).size <= MAX_CONFIG_BYTES, 'Configuration exceeds 32 MiB');
  return parseYaml(await readFile(file, 'utf8'));
}
export async function loadDocument(project) {
  const root = await realpath(project);
  const file = await safeFile(root, 'urlcode.yaml');
  const document = validateDocument(await readConfig(file));
  const routes = Object.assign(Object.create(null), document.routes);
  const files = [file];
  for (const include of document.includes || []) {
    const path = await safeFile(root, include);
    assert(!files.includes(path), 'Duplicate include');
    files.push(path);
    const part = validateDocument(await readConfig(path));
    assert(!part.includes?.length, 'Nested includes are unsupported');
    assert(part.dynamicLinks===undefined, 'dynamicLinks may only be set in the entry urlcode.yaml');
    for (const [pattern, route] of Object.entries(part.routes)) {
      assert(!Object.hasOwn(routes, pattern), 'Duplicate route across files');
      routes[pattern] = route;
    }
  }
  assert(Object.keys(routes).length <= 100000, 'Maximum 100000 routes per project');
  assert(document.dynamicLinks===true || !Object.values(routes).some(route=>route.link), 'Link routes require dynamicLinks: true in urlcode.yaml');
  return { root, document, routes, files, version: createHash('sha256').update(JSON.stringify(document.dynamicLinks===true?{routes,dynamicLinks:true}:routes)).digest('hex').slice(0, 16) };
}
export async function loadBindings(root, local = false, environment = process.env) {
  let vars = {};
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
        const [, key, raw] = match;
        assert(!Object.hasOwn(vars, key), 'Duplicate .env.local name');
        let value = raw.trim();
        if (value.startsWith('"') || value.startsWith("'")) {
          assert(value.length >= 2 && value.endsWith(value[0]), 'Invalid .env.local quote');
          value = value.slice(1, -1);
        }
        vars[key] = value;
      }
    } catch (error) {
      // Only absence is optional. Malformed files and unsafe symlinks fail closed.
      try { await lstat(resolve(root, '.env.local')); } catch (e) { if (e.code === 'ENOENT') return { ...environment }; }
      throw error;
    }
  }
  return { ...vars, ...environment };
}
export async function functionFile(root, file) {
  assert(['.mjs', '.js'].includes(extname(file)), 'Functions must be JavaScript ES modules (.mjs or .js)');
  return safeFile(root, file);
}
