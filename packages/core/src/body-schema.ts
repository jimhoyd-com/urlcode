import { assert } from './errors.ts';
import { assertSafePattern, maxPatternInputLength } from './pattern-guard.ts';
import { isRecord, own } from './object-guards.ts';

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
/** The supported subset, stated up front by the capability catalog and checked against the schema description (#587). */
export const bodySchemaSubset = { keywords: [...keywords], types: [...types], formats: ['uuid'], patternMaxLength: maxPatternInputLength, limits: { ...limits } } as const;
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
 * One validation failure. `pointer` is an RFC 6901 pointer built only from names
 * the schema declared (array positions appear as `[]`, not an index), `keyword`
 * is the schema keyword that failed, and `expected` is the schema's own
 * constraint. Nothing the client sent is ever placed in an issue.
 */
interface BodySchemaIssue { pointer: string; keyword: string; message: string; expected?: string | number | (string | number | boolean | null)[]; property?: string }
const escapePointer = (name: string): string => name.replace(/~/g, '~0').replace(/\//g, '~1');
/** Structured failures for `value`; `checkBodySchema` renders the same list as text. */
export function bodySchemaIssues(schema: BodySchema, value: unknown, path = '', issues: BodySchemaIssue[] = [], max = 8): BodySchemaIssue[] {
  const fail = (keyword: string, message: string, extra: Partial<BodySchemaIssue> = {}): void => { if (issues.length < max) issues.push({ pointer: path, keyword, message, ...extra }); };
  const kind = schema.type;
  if (kind) {
    const actual = describe(value);
    const ok = kind === 'integer' ? Number.isInteger(value) : kind === 'number' ? typeof value === 'number' : actual === kind;
    if (!ok) { fail('type', `must be ${kind === 'array' || kind === 'object' || kind === 'integer' ? 'an' : 'a'} ${kind}`, { expected: kind }); return issues; }
  }
  if (schema.enum && !schema.enum.some(item => item === value)) {
    const listable = schema.enum.length <= 16 && schema.enum.every(item => typeof item !== 'string' || item.length <= 64);
    fail('enum', 'must be one of the declared values', listable ? { expected: schema.enum } : {});
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) fail('minLength', `must be at least ${schema.minLength} characters`, { expected: schema.minLength });
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail('maxLength', `must be at most ${schema.maxLength} characters`, { expected: schema.maxLength });
    else {
      if (schema.format === 'uuid' && !uuidFormat.test(value)) fail('format', 'must be a uuid', { expected: 'uuid' });
      if (schema.pattern !== undefined) {
        let regex = patterns.get(schema);
        if (!regex) patterns.set(schema, regex = new RegExp(schema.pattern, 'u'));
        if (!regex.test(value)) fail('pattern', 'does not match the declared pattern');
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('minimum', `must be at least ${schema.minimum}`, { expected: schema.minimum });
    if (schema.maximum !== undefined && value > schema.maximum) fail('maximum', `must be at most ${schema.maximum}`, { expected: schema.maximum });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('minItems', `must have at least ${schema.minItems} items`, { expected: schema.minItems });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('maxItems', `must have at most ${schema.maxItems} items`, { expected: schema.maxItems });
    else if (schema.items) for (const item of value) { if (issues.length >= max) break; bodySchemaIssues(schema.items, item, `${path}/[]`, issues, max); }
  }
  if (isRecord(value)) {
    const declared = schema.properties || {};
    for (const name of schema.required || []) if (!own(value, name)) fail('required', `is missing required property ${name}`, { property: name });
    if (schema.additionalProperties === false && Object.keys(value).some(name => !own(declared, name))) fail('additionalProperties', 'has a property the schema does not declare');
    for (const [name, child] of Object.entries(declared)) if (own(value, name)) bodySchemaIssues(child, value[name], `${path}/${escapePointer(name)}`, issues, max);
  }
  return issues;
}
/**
 * Returns fixed-wording failures for `value`, each naming only a path the
 * schema itself declared (array positions appear as `[]`). Nothing the client
 * sent is echoed, so the answer stays safe to render as plain text.
 */
export function checkBodySchema(schema: BodySchema, value: unknown): string[] {
  return bodySchemaIssues(schema, value).map(bodySchemaLine);
}
/** The plain-text line for an issue: array positions print as `[]` appended to the path, root as `/`. */
export const bodySchemaLine = (issue: BodySchemaIssue): string => `${issue.pointer.replace(/\/\[\]/g, '[]') || '/'} ${issue.message}`;

/**
 * Negotiation rule (conservative): the structured answer is sent only when the
 * Accept header names application/json explicitly with q > 0 and no higher q
 * for an explicit text/plain. Wildcard ranges, a missing header and everything
 * else keep the plain-text answer, so curl, browsers and existing clients see
 * no change.
 */
export function prefersJson(accept: string | null | undefined): boolean {
  if (!accept || accept.length > 1024) return false;
  let json = 0, text = 0;
  for (const range of accept.split(',')) {
    const [type = '', ...params] = range.split(';').map(part => part.trim().toLowerCase());
    const q = params.find(param => param.startsWith('q='));
    const weight = q === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q.slice(2)) : 0; // a malformed weight never opts in
    if (type === 'application/json') json = Math.max(json, weight);
    else if (type === 'text/plain') text = Math.max(text, weight);
  }
  return json > 0 && json >= text;
}
const maxIssueBytes = 4096;
/** Renders the JSON answer: never more than `maxIssueBytes`, dropping trailing issues and saying so. */
export function bodySchemaJson(issues: BodySchemaIssue[]): string {
  const shape = (list: BodySchemaIssue[], truncated: boolean): string => JSON.stringify({ error: 'body_validation_failed', message: 'Request body failed validation', ...(truncated ? { truncated } : {}), issues: list });
  let list = issues, text = shape(list, false);
  while (new TextEncoder().encode(text).length > maxIssueBytes && list.length) { list = list.slice(0, -1); text = shape(list, true); }
  return text;
}
