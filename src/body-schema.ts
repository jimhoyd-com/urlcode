import { assert } from './errors.ts';
import { assertSafePattern, maxPatternInputLength } from './pattern-guard.ts';

/**
 * The JSON Schema subset a route may declare for `request.body.schema`.
 * It is interpreted here rather than compiled by Ajv so the same code runs on
 * every host, including the Worker, with no code generation and no author
 * regex outside `pattern-guard.ts`.
 */
export interface BodySchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  properties?: Record<string, BodySchema>; required?: string[]; additionalProperties?: boolean;
  items?: BodySchema; enum?: (string | number | boolean | null)[];
  minLength?: number; maxLength?: number; pattern?: string; format?: 'uuid';
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
}
export const uuidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const types = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
const keywords = new Set(['type','properties','required','additionalProperties','items','enum','minLength','maxLength','pattern','format','minimum','maximum','minItems','maxItems']);
const limits = { depth: 6, nodes: 128, properties: 64, enums: 64, length: 8192, items: 10000 };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (object: object, key: string): boolean => Object.hasOwn(object, key);
const patterns = new WeakMap<BodySchema, RegExp>();

/** Rejects, at load time, any schema outside the supported subset or its limits. */
export function assertBodySchema(schema: unknown): asserts schema is BodySchema {
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    assert(isRecord(node), 'Body schema must be an object');
    assert(depth <= limits.depth && ++nodes <= limits.nodes, 'Body schema is too large or deeply nested');
    for (const key of Object.keys(node)) assert(keywords.has(key), `Unsupported body schema keyword: ${key}`);
    const kind = node.type;
    assert(kind === undefined || (typeof kind === 'string' && types.includes(kind)), 'Body schema type must be one of ' + types.join(', '));
    const isKind = (...allowed: string[]): boolean => typeof kind === 'string' && allowed.includes(kind);
    const uses = (...names: string[]): boolean => names.some(name => own(node, name));
    assert(!uses('properties', 'required', 'additionalProperties') || isKind('object'), 'properties, required and additionalProperties require type object');
    assert(!uses('items', 'minItems', 'maxItems') || isKind('array'), 'items, minItems and maxItems require type array');
    assert(!uses('minLength', 'maxLength', 'pattern', 'format') || isKind('string'), 'String keywords require type string');
    assert(!uses('minimum', 'maximum') || isKind('integer', 'number'), 'Numeric bounds require type integer or number');
    for (const name of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (!own(node, name)) continue;
      const value = node[name], cap = name.endsWith('Items') ? limits.items : limits.length;
      assert(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= cap, `${name} must be an integer from 0 to ${cap}`);
    }
    for (const name of ['minimum', 'maximum']) assert(!own(node, name) || (typeof node[name] === 'number' && Number.isFinite(node[name])), `${name} must be a finite number`);
    if (own(node, 'format')) assert(node.format === 'uuid', 'Unsupported body schema format (supported: uuid)');
    if (own(node, 'pattern')) {
      assert(typeof node.pattern === 'string', 'pattern must be a string');
      assertSafePattern(node.pattern);
      assert(typeof node.maxLength === 'number' && node.maxLength <= maxPatternInputLength, `pattern requires maxLength of at most ${maxPatternInputLength}`);
    }
    if (own(node, 'enum')) {
      assert(Array.isArray(node.enum) && node.enum.length >= 1 && node.enum.length <= limits.enums, `enum must list 1 to ${limits.enums} values`);
      assert(node.enum.every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)), 'enum values must be scalars');
    }
    if (own(node, 'required')) {
      assert(Array.isArray(node.required) && node.required.every(name => typeof name === 'string') && new Set(node.required).size === node.required.length, 'required must be a list of unique names');
      const declared = isRecord(node.properties) ? node.properties : {};
      assert((node.required as string[]).every(name => own(declared, name)), 'required names must be declared in properties');
    }
    if (own(node, 'additionalProperties')) assert(typeof node.additionalProperties === 'boolean', 'additionalProperties must be true or false');
    if (own(node, 'properties')) {
      assert(isRecord(node.properties) && Object.keys(node.properties).length <= limits.properties, `properties must declare at most ${limits.properties} names`);
      for (const child of Object.values(node.properties)) walk(child, depth + 1);
    }
    if (own(node, 'items')) walk(node.items, depth + 1);
  };
  walk(schema, 1);
}

const describe = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
/**
 * Returns fixed-wording failures for `value`, each naming only a path the
 * schema itself declared (array positions appear as `[]`). Nothing the client
 * sent is echoed, so the answer stays safe to render as plain text.
 */
export function checkBodySchema(schema: BodySchema, value: unknown, path = '', errors: string[] = [], max = 8): string[] {
  const here = path || '/';
  const fail = (message: string): void => { if (errors.length < max) errors.push(`${here} ${message}`); };
  const kind = schema.type;
  if (kind) {
    const actual = describe(value);
    const ok = kind === 'integer' ? Number.isInteger(value) : kind === 'number' ? typeof value === 'number' : actual === kind;
    if (!ok) { fail(`must be ${kind === 'array' || kind === 'object' || kind === 'integer' ? 'an' : 'a'} ${kind}`); return errors; }
  }
  if (schema.enum && !schema.enum.some(item => item === value)) fail('must be one of the declared values');
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    else {
      if (schema.format === 'uuid' && !uuidFormat.test(value)) fail('must be a uuid');
      if (schema.pattern !== undefined) {
        let regex = patterns.get(schema);
        if (!regex) patterns.set(schema, regex = new RegExp(schema.pattern, 'u'));
        if (!regex.test(value)) fail('does not match the declared pattern');
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    else if (schema.items) for (const item of value) { if (errors.length >= max) break; checkBodySchema(schema.items, item, `${path}[]`, errors, max); }
  }
  if (isRecord(value)) {
    const declared = schema.properties || {};
    for (const name of schema.required || []) if (!own(value, name)) fail(`is missing required property ${name}`);
    if (schema.additionalProperties === false && Object.keys(value).some(name => !own(declared, name))) fail('has a property the schema does not declare');
    for (const [name, child] of Object.entries(declared)) if (own(value, name)) checkBodySchema(child, value[name], `${path}/${name}`, errors, max);
  }
  return errors;
}
