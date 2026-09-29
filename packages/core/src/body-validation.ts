import { ConfigError } from './errors.ts';
import { assertSafePattern, maxPatternInputLength } from './pattern-guard.ts';
import { isRecord, own } from './object-guards.ts';
import { bodySchemaFormatMaxLength } from './body-formats.ts';

// The request body schema profile: which JSON Schema 2020-12 documents a route may declare as
// `request.body.<METHOD>.schema`, and how a validator's failures become the bounded 422 answer. This module
// never compiles anything, so the Cloudflare Worker (which forbids code generation) imports it too:
// Node hosts compile a profile schema with Ajv at load time (body-schema.ts) and the Worker build
// ships the same Ajv output as standalone code (build-cloudflare.ts). Both then report failures here.

/** The only dialect a body schema may name in `$schema`; a schema without `$schema` is read as this dialect. */
export const bodySchemaDialect = 'https://json-schema.org/draft/2020-12/schema';
export type BodySchemaType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
/** A JSON Schema 2020-12 object schema in the supported profile (checked by `assertBodySchema`, not by this type). */
export interface BodySchema {
  [keyword: string]: unknown;
  type?: BodySchemaType | BodySchemaType[];
  properties?: Record<string, BodySchema | boolean>;
  required?: string[];
}
/** The `uuid` format; the other formats (for body and parameter schemas alike) are body-formats.ts. */
export const uuidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * The largest request body any route admits: `request.body.<METHOD>.maxBytes` is at most this and defaults to it, on every host
 * (#713). A JSON string can never hold more characters than its body has bytes, so it is also the string-length cap.
 */
export const maxRequestBodyBytes = 1048576;

const types: readonly BodySchemaType[] = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
/** How each supported keyword's value is checked; see `bodySchemaProfile` for the published list. */
const keywordKinds = {
  $schema: 'dialect', $defs: 'defs', $ref: 'ref', $comment: 'text', title: 'text', description: 'text', examples: 'examples', deprecated: 'boolean',
  type: 'type', enum: 'enum', const: 'const',
  allOf: 'schemas', anyOf: 'schemas', oneOf: 'schemas', not: 'schema',
  properties: 'properties', patternProperties: 'patternProperties', additionalProperties: 'schema', propertyNames: 'schema',
  required: 'required', minProperties: 'count', maxProperties: 'count',
  items: 'schema', prefixItems: 'schemas', minItems: 'count', maxItems: 'count', uniqueItems: 'boolean',
  minLength: 'length', maxLength: 'length', pattern: 'pattern', format: 'format',
  minimum: 'number', maximum: 'number', exclusiveMinimum: 'number', exclusiveMaximum: 'number', multipleOf: 'positive',
} as const;
type KeywordKind = typeof keywordKinds[keyof typeof keywordKinds];
/** Why a well-known JSON Schema keyword outside the profile is refused, so the diagnostic says what to do instead. */
const refusedBecause: Record<string, string> = {
  $id: 'schema identifiers are not resolved; use a local #/$defs reference', $anchor: 'anchors are not resolved; use a local #/$defs reference',
  $dynamicRef: 'dynamic references are not supported', $dynamicAnchor: 'dynamic references are not supported',
  $recursiveRef: 'dynamic references are not supported', $recursiveAnchor: 'dynamic references are not supported', $vocabulary: 'custom vocabularies are not supported',
  definitions: 'use $defs (JSON Schema 2020-12)', dependencies: 'not part of JSON Schema 2020-12', nullable: 'use a type list that includes "null"',
  default: 'the runtime does not fill in request body defaults', readOnly: 'the runtime does not enforce readOnly', writeOnly: 'the runtime does not enforce writeOnly',
};
/** The instance types a type-specific keyword constrains; beside a `type` that excludes them all, it can never run. */
const appliesTo: Record<string, readonly BodySchemaType[]> = {
  minLength: ['string'], maxLength: ['string'], pattern: ['string'], format: ['string'],
  minimum: ['number', 'integer'], maximum: ['number', 'integer'], exclusiveMinimum: ['number', 'integer'], exclusiveMaximum: ['number', 'integer'], multipleOf: ['number', 'integer'],
  items: ['array'], prefixItems: ['array'], minItems: ['array'], maxItems: ['array'], uniqueItems: ['array'],
  properties: ['object'], patternProperties: ['object'], additionalProperties: ['object'], propertyNames: ['object'], required: ['object'], minProperties: ['object'], maxProperties: ['object'],
};
const formats = Object.keys(bodySchemaFormatMaxLength);
const limits = {
  depth: 8, nodes: 256, expandedNodes: 1024, refs: 32, defs: 32, properties: 64, patternProperties: 16, branches: 16, enums: 64, required: 64,
  length: maxRequestBodyBytes, items: 10000, uniqueItems: 64, text: 4096, examples: 16,
};
/**
 * The supported JSON Schema 2020-12 profile, stated up front by the capability catalog and checked against the schema
 * description (#587). A keyword outside `keywords`, a `format` outside `formats` or a schema over a limit fails at load.
 */
export const bodySchemaProfile = {
  dialect: bodySchemaDialect, keywords: Object.keys(keywordKinds), types: [...types], formats, formatMaxLength: { ...bodySchemaFormatMaxLength }, patternMaxLength: maxPatternInputLength, limits: { ...limits },
} as const;

const pointerCap = 256;
const escapePointer = (name: string): string => name.replace(/~/g, '~0').replace(/\//g, '~1');
/** A JSON pointer into the author's schema for a diagnostic: bounded and free of control characters. */
const shown = (pointer: string): string => {
  const clean = (pointer || '/').replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > pointerCap ? clean.slice(0, pointerCap) + '...' : clean;
};
const defName = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const localRef = /^#\/\$defs\/([A-Za-z_][A-Za-z0-9_.-]{0,63})$/;

/** The subschemas directly under one schema node, each with its pointer suffix. `$defs` is not a child; refs reach it. */
function children(node: Record<string, unknown>): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(node)) {
    const kind = (keywordKinds as Record<string, KeywordKind | undefined>)[key];
    if (kind === 'schema') out.push([`/${key}`, value]);
    else if (kind === 'schemas' && Array.isArray(value)) value.forEach((child, index) => out.push([`/${key}/${index}`, child]));
    else if ((kind === 'properties' || kind === 'patternProperties') && isRecord(value)) for (const [name, child] of Object.entries(value)) out.push([`/${key}/${escapePointer(name)}`, child]);
  }
  return out;
}

/**
 * Rejects, at load time, any schema outside the supported profile or its limits, naming the keyword and the JSON
 * pointer into the schema. It never echoes a `$ref` value, which could carry a URL with credentials.
 */
export function assertBodySchema(schema: unknown): asserts schema is BodySchema {
  function fail(pointer: string, problem: string): never { throw new ConfigError(`Body schema ${shown(pointer)}: ${problem}`); }
  if (!isRecord(schema)) fail('', 'must be an object');
  const root = schema as Record<string, unknown>;
  const defs = own(root, '$defs') ? root.$defs : {};
  if (!isRecord(defs)) fail('/$defs', 'must map names to schemas');
  const definitions = defs as Record<string, unknown>;
  if (Object.keys(definitions).length > limits.defs) fail('/$defs', `declares more than ${limits.defs} schemas`);
  for (const name of Object.keys(definitions)) if (!defName.test(name)) fail('/$defs', 'names must be 1 to 64 letters, digits, _, . or - and start with a letter or _');
  let nodes = 0, refs = 0;
  const walk = (node: unknown, pointer: string, depth: number): void => {
    if (depth > limits.depth) fail(pointer, `nests deeper than ${limits.depth} levels`);
    if (++nodes > limits.nodes) fail(pointer, `has more than ${limits.nodes} schema nodes`);
    if (typeof node === 'boolean') return;
    if (!isRecord(node)) fail(pointer, 'must be an object or a boolean');
    const here = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(here)) {
      const at = `${pointer}/${escapePointer(key)}`;
      const kind = own(keywordKinds, key) ? keywordKinds[key as keyof typeof keywordKinds] : undefined;
      if (!kind) {
        const shownKey = key.length > 64 ? key.slice(0, 64) + '...' : key;
        fail(at, `keyword ${JSON.stringify(shownKey)} is not in the supported JSON Schema 2020-12 profile${own(refusedBecause, key) ? ` (${refusedBecause[key]})` : ''}`);
      }
      checkKeyword(kind!, key, value, here, at, pointer === '');
    }
    checkCoherence(here, pointer);
    for (const [suffix, child] of children(here)) walk(child, pointer + suffix, depth + 1);
  };
  // Conditions a schema can satisfy keyword by keyword yet still be an authoring mistake: Ajv's strict mode refuses
  // some of them at compile time with an unpointed message, and the rest leave a keyword that can never run or a
  // schema nothing can satisfy. Each is refused here, with the pointer and a hint, before Ajv sees the schema.
  const checkCoherence = (node: Record<string, unknown>, pointer: string): void => {
    const declared = Array.isArray(node.type) ? node.type as BodySchemaType[] : typeof node.type === 'string' ? [node.type as BodySchemaType] : undefined;
    if (declared) {
      for (const key of Object.keys(node)) {
        const applies = own(appliesTo, key) ? appliesTo[key]! : undefined;
        if (applies && !applies.some(type => declared.includes(type)))
          fail(`${pointer}/${key}`, `${key} applies only to ${applies.join(' or ')} values, but this schema's type is ${declared.join(', ')}, so it would never run; drop it or add the type`);
      }
      const fits = (value: unknown): boolean => value === null ? declared.includes('null')
        : typeof value === 'number' ? declared.includes('number') || (declared.includes('integer') && Number.isInteger(value))
        : declared.includes(typeof value as BodySchemaType);
      // The value itself is never echoed: it may be a string constant.
      if (own(node, 'const') && !fits(node.const)) fail(`${pointer}/const`, `the value is not of this schema's type (${declared.join(', ')}), so nothing can match it`);
      if (Array.isArray(node.enum)) node.enum.forEach((value, index) => { if (!fits(value)) fail(`${pointer}/enum/${index}`, `the value is not of this schema's type (${declared.join(', ')}), so it can never match; drop it or add the type`); });
    }
    const properties = isRecord(node.properties) ? Object.keys(node.properties) : [];
    const patterns = isRecord(node.patternProperties) ? Object.keys(node.patternProperties).map(source => ({ source, regex: new RegExp(source, 'u') })) : [];
    for (const name of properties) {
      const match = patterns.find(pattern => pattern.regex.test(name));
      if (match) fail(`${pointer}/properties/${escapePointer(name)}`, `is also matched by ${shown(`${pointer}/patternProperties/${escapePointer(match.source)}`)}, so both schemas would apply (Ajv strict mode refuses this); narrow the pattern or keep the property's rules in one place`);
    }
    if (node.additionalProperties === false && Array.isArray(node.required)) node.required.forEach((name, index) => {
      if (!properties.includes(name as string) && !patterns.some(pattern => pattern.regex.test(name as string)))
        fail(`${pointer}/required/${index}`, 'names a property that additionalProperties: false forbids (it is not in properties and matches no patternProperties pattern), so no object can satisfy this schema; declare it in properties');
    });
    if (node.items === false && typeof node.minItems === 'number') {
      const room = Array.isArray(node.prefixItems) ? node.prefixItems.length : 0;
      if (node.minItems > room) fail(`${pointer}/minItems`, `requires more than the ${room} items prefixItems allows while items is false, so no array can satisfy this schema; declare more prefixItems or drop items: false`);
    }
  };
  const count = (value: unknown, at: string, cap: number): void => { if (!(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= cap)) fail(at, `must be an integer from 0 to ${cap}`); };
  const scalar = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  const checkKeyword = (kind: KeywordKind, key: string, value: unknown, node: Record<string, unknown>, at: string, isRoot: boolean): void => {
    switch (kind) {
      case 'dialect': if (!isRoot) fail(at, '$schema is allowed only at the root'); if (value !== bodySchemaDialect) fail(at, `only ${bodySchemaDialect} is supported`); return;
      case 'defs': if (!isRoot) fail(at, '$defs is allowed only at the root'); return;
      case 'ref': {
        if (++refs > limits.refs) fail(at, `more than ${limits.refs} $ref uses`);
        const target = typeof value === 'string' ? localRef.exec(value) : null;
        // The value is not echoed: a remote reference may be a URL with credentials in it.
        if (!target) fail(at, '$ref must be a local #/$defs/<name> reference; remote, $id-relative and JSON-pointer references into other keywords are not resolved or fetched');
        if (!own(definitions, target![1]!)) fail(at, '$ref names a $defs entry that is not declared');
        return;
      }
      case 'text': if (typeof value !== 'string' || value.length > limits.text) fail(at, `must be a string of at most ${limits.text} characters`); return;
      case 'examples': if (!Array.isArray(value) || value.length > limits.examples) fail(at, `must be a list of at most ${limits.examples} values`); return;
      case 'boolean': if (typeof value !== 'boolean') fail(at, 'must be true or false');
        if (key === 'uniqueItems' && value === true && !(typeof node.maxItems === 'number' && node.maxItems <= limits.uniqueItems)) fail(at, `uniqueItems requires maxItems of at most ${limits.uniqueItems} on the same schema`);
        return;
      case 'type': {
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || !list.every(item => typeof item === 'string' && types.includes(item as BodySchemaType)) || new Set(list).size !== list.length) fail(at, `must be one of ${types.join(', ')} or a list of distinct ones`);
        return;
      }
      case 'enum': if (!Array.isArray(value) || value.length < 1 || value.length > limits.enums || !value.every(scalar)) fail(at, `must list 1 to ${limits.enums} scalar values (string, number, boolean or null)`); return;
      case 'const': if (!scalar(value)) fail(at, 'must be a scalar value (string, number, boolean or null)'); return;
      case 'schemas': if (!Array.isArray(value) || value.length < 1 || value.length > limits.branches) fail(at, `must list 1 to ${limits.branches} schemas`); return;
      case 'schema': return;
      case 'properties': if (!isRecord(value) || Object.keys(value).length > limits.properties) fail(at, `must map at most ${limits.properties} property names to schemas`); return;
      case 'patternProperties': {
        if (!isRecord(value) || Object.keys(value).length < 1 || Object.keys(value).length > limits.patternProperties) fail(at, `must map 1 to ${limits.patternProperties} patterns to schemas`);
        const names = node.propertyNames;
        // Every property name is tested against every pattern, so the names themselves need the regex input bound.
        if (!(isRecord(names) && typeof names.maxLength === 'number' && names.maxLength <= maxPatternInputLength)) fail(at, `patternProperties requires propertyNames with maxLength of at most ${maxPatternInputLength} on the same schema`);
        for (const pattern of Object.keys(value as object)) guardPattern(pattern, `${at}/${escapePointer(pattern)}`);
        return;
      }
      case 'required':
        if (!Array.isArray(value) || value.length > limits.required || !value.every(name => typeof name === 'string') || new Set(value).size !== value.length) fail(at, `must be a list of at most ${limits.required} unique names`);
        return;
      case 'count': count(value, at, limits.items); return;
      case 'length': count(value, at, limits.length); return;
      case 'pattern':
        if (typeof value !== 'string') fail(at, 'must be a string');
        guardPattern(value as string, at);
        // Admitted patterns are cheap only on bounded input; maxLength is checked before pattern at request time.
        if (!(typeof node.maxLength === 'number' && node.maxLength <= maxPatternInputLength)) fail(at, `pattern requires maxLength of at most ${maxPatternInputLength} on the same schema`);
        return;
      // A format bounds its own input (`formatMaxLength`), so unlike `pattern` it needs no maxLength beside it.
      case 'format': if (typeof value !== 'string' || !formats.includes(value)) fail(at, `unsupported format (supported: ${formats.join(', ')})`); return;
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail(at, 'must be a finite number'); return;
      case 'positive': if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(at, 'must be a finite number greater than 0'); return;
    }
  };
  const guardPattern = (pattern: string, at: string): void => {
    try { assertSafePattern(pattern); } catch (error) { fail(at, (error as Error).message); }
  };
  walk(root, '', 1);
  for (const [name, child] of Object.entries(definitions)) walk(child, `/$defs/${escapePointer(name)}`, 2);
  // Local references may not form a cycle, and the schema they expand to stays bounded: validation cost follows the
  // expanded schema, so a chain of small definitions each used several times is refused like one large schema.
  const sizes = new Map<string, number>(), active = new Set<string>();
  const expanded = (node: unknown, pointer: string): number => {
    if (!isRecord(node)) return 1;
    let total = 1;
    const ref = typeof node.$ref === 'string' ? localRef.exec(node.$ref)?.[1] : undefined;
    if (ref !== undefined) {
      if (active.has(ref)) fail(pointer + '/$ref', 'recursive $ref (a cycle through $defs) is not supported');
      let size = sizes.get(ref);
      if (size === undefined) { active.add(ref); size = expanded(definitions[ref], `/$defs/${escapePointer(ref)}`); active.delete(ref); sizes.set(ref, size); }
      total += size;
    }
    for (const [suffix, child] of children(node)) { total += expanded(child, pointer + suffix); if (total > limits.expandedNodes) break; }
    if (total > limits.expandedNodes) fail(pointer, `expands through $ref to more than ${limits.expandedNodes} schema nodes`);
    return total;
  };
  expanded(root, '');
}

/**
 * The diagnostic for a schema the profile admitted but Ajv still refused to compile, in the same `Body schema
 * <pointer>: <problem>` form as `assertBodySchema`. `schemaErrors` are Ajv's meta-schema errors (its `errors` after a
 * failed compile), whose `instancePath` is a pointer into the schema. Otherwise the pointer comes from a path Ajv
 * wrote into its message, or is the root. Ajv's own words are kept only after redaction: quoted text (a format, a
 * keyword, a string constant) and anything shaped like a URL or `#` reference are elided, control characters are
 * replaced and the result is capped, so a `$ref` value or a string constant is never echoed.
 */
export function bodySchemaRefusal(error: unknown, schemaErrors?: readonly { instancePath?: string; keyword?: string }[] | null): string {
  const first = schemaErrors?.[0];
  if (first) {
    const keyword = typeof first.keyword === 'string' && /^\$?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(first.keyword) ? first.keyword : 'schema';
    return `Body schema ${shown(first.instancePath ?? '')}: does not satisfy the JSON Schema 2020-12 meta-schema at keyword ${keyword}`;
  }
  if (isRecord(error) && own(error, 'missingRef')) return 'Body schema /: a $ref could not be resolved (only a local #/$defs/<name> reference is supported)';
  const message = String(isRecord(error) && typeof error.message === 'string' ? error.message : error);
  const path = /\bat path "#?(\/[^"]*)"/.exec(message)?.[1];
  const detail = message
    .replace(/\s*(?:ignored )?in schema at path "[^"]*"/g, '').replace(/^strict mode:\s*/, '').replace(/\s*\(use [^)]*\)/g, '')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"..."').replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*|#\/\S*/g, '<ref>')
    .replace(/[\u0000-\u001f\u007f]/g, '?').replace(/\s+/g, ' ').trim();
  const capped = detail.length > 160 ? detail.slice(0, 160) + '...' : detail;
  return `Body schema ${shown(path ?? '')}: the JSON Schema 2020-12 validator refused this schema${capped ? ` (${capped})` : ''}`;
}

/** Every property name the schema itself declares (in `properties` or `required`); only these may appear in an issue pointer. */
export function declaredBodyNames(schema: BodySchema): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (isRecord(node.properties)) for (const name of Object.keys(node.properties)) names.add(name);
    if (Array.isArray(node.required)) for (const name of node.required) if (typeof name === 'string') names.add(name);
    for (const [, child] of children(node)) visit(child);
  };
  visit(schema);
  if (isRecord(schema.$defs)) for (const child of Object.values(schema.$defs)) visit(child);
  return names;
}

/** The Ajv options every host compiles a body schema with, so the Node validator and the Worker's standalone code agree. */
export const bodySchemaAjvOptions = {
  strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
  // Ajv's own advice for untrusted data: stop at the first failure, so one request cannot make the validator
  // allocate an error per array element. The profile walk above is the primary gate; strict mode is a second one.
  allErrors: false, messages: false, ownProperties: true, unicodeRegExp: true, validateFormats: true, logger: false,
} as const;

/** One error as Ajv reports it (only the fields this module reads). */
export interface BodyValidationError { instancePath: string; schemaPath: string; keyword: string; params: Record<string, unknown>; propertyName?: string }
/** A compiled validator: Ajv's function, or its standalone code on the Worker. */
export type BodyValidator = ((value: unknown) => boolean) & { errors?: readonly BodyValidationError[] | null | undefined };
/** What a host keeps per route: the validator and the names an issue pointer may show. */
export interface CompiledBodySchema { validate: BodyValidator; names: ReadonlySet<string> }

/**
 * One validation failure. `pointer` is an RFC 6901 pointer built only from names the schema declared (array positions
 * appear as `[]`, any other property the client sent as `*`), `keyword` is the schema keyword that failed, and
 * `expected` is the schema's own constraint. No client value is ever placed in an issue; the only client text is an
 * identifier-shaped undeclared property name in `property`.
 */
export interface BodySchemaIssue { pointer: string; keyword: string; message: string; expected?: string | number | (string | number | boolean | null)[]; property?: string }
const nameable = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const article = (type: string): string => type === 'null' ? 'null' : `${['array', 'object', 'integer'].includes(type) ? 'an' : 'a'} ${type}`;
const listable = (values: unknown): values is (string | number | boolean | null)[] =>
  Array.isArray(values) && values.length <= 16 && values.every(item => item === null || typeof item === 'number' || typeof item === 'boolean' || (typeof item === 'string' && item.length <= 64));

/** The pointer for an Ajv instance path: declared names kept, array positions `[]`, anything else the client chose `*`. */
function issuePointer(instancePath: string, value: unknown, names: ReadonlySet<string>): string {
  if (!instancePath) return '';
  let current: unknown = value, out = '';
  for (const raw of instancePath.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) { out += '/[]'; current = current[Number(key)]; continue; }
    out += names.has(key) ? `/${escapePointer(key)}` : '/*';
    current = isRecord(current) && own(current, key) ? current[key] : undefined;
  }
  return out;
}
function describe(error: BodyValidationError): Omit<BodySchemaIssue, 'pointer'> {
  const p = error.params, limit = typeof p.limit === 'number' ? p.limit : undefined;
  // Ajv reports a property name failure twice (the inner keyword, carrying the name, and propertyNames itself); both
  // become the same issue, which `bodyIssues` keeps once. The name itself is client data and is never shown.
  if (error.propertyName !== undefined || error.keyword === 'propertyNames') return { keyword: 'propertyNames', message: 'has a property name the schema does not allow' };
  switch (error.keyword) {
    case 'type': {
      const list = Array.isArray(p.type) ? p.type.map(String) : String(p.type).split(',');
      return list.length === 1 ? { keyword: 'type', message: `must be ${article(list[0]!)}`, expected: list[0]! } : { keyword: 'type', message: `must be ${list.join(' or ')}`, expected: list };
    }
    case 'enum': return { keyword: 'enum', message: 'must be one of the declared values', ...(listable(p.allowedValues) ? { expected: p.allowedValues } : {}) };
    case 'const': return { keyword: 'const', message: 'must equal the declared value', ...(listable([p.allowedValue]) ? { expected: [p.allowedValue] as (string | number | boolean | null)[] } : {}) };
    case 'required': return { keyword: 'required', message: `is missing required property ${String(p.missingProperty)}`, property: String(p.missingProperty) };
    case 'additionalProperties': {
      // An identifier-shaped name is the client's own key, echoed back in `property` so the sender can see which one;
      // any other name is left out rather than escaped.
      const name = String(p.additionalProperty);
      return { keyword: 'additionalProperties', message: 'has a property the schema does not declare', ...(nameable.test(name) ? { property: name } : {}) };
    }
    case 'minLength': return { keyword: 'minLength', message: `must be at least ${limit} characters`, expected: limit! };
    case 'maxLength': return { keyword: 'maxLength', message: `must be at most ${limit} characters`, expected: limit! };
    case 'pattern': return { keyword: 'pattern', message: 'does not match the declared pattern' };
    case 'format': { const format = String(p.format); return { keyword: 'format', message: `must be ${/^(?:email|ip)/.test(format) ? 'an' : 'a'} ${format}`, expected: format }; }
    case 'minimum': return { keyword: 'minimum', message: `must be at least ${limit}`, expected: limit! };
    case 'maximum': return { keyword: 'maximum', message: `must be at most ${limit}`, expected: limit! };
    case 'exclusiveMinimum': return { keyword: 'exclusiveMinimum', message: `must be greater than ${limit}`, expected: limit! };
    case 'exclusiveMaximum': return { keyword: 'exclusiveMaximum', message: `must be less than ${limit}`, expected: limit! };
    case 'multipleOf': return { keyword: 'multipleOf', message: `must be a multiple of ${String(p.multipleOf)}`, expected: Number(p.multipleOf) };
    case 'minItems': return { keyword: 'minItems', message: `must have at least ${limit} items`, expected: limit! };
    case 'maxItems': return { keyword: 'maxItems', message: `must have at most ${limit} items`, expected: limit! };
    case 'items': return { keyword: 'items', message: `must have at most ${limit} items`, expected: limit! }; // `items: false` after `prefixItems`
    case 'uniqueItems': return { keyword: 'uniqueItems', message: 'must not contain duplicate items' };
    case 'minProperties': return { keyword: 'minProperties', message: `must have at least ${limit} properties`, expected: limit! };
    case 'maxProperties': return { keyword: 'maxProperties', message: `must have at most ${limit} properties`, expected: limit! };
    case 'anyOf': return { keyword: 'anyOf', message: 'must match at least one declared alternative' };
    case 'oneOf': return { keyword: 'oneOf', message: 'must match exactly one declared alternative' };
    case 'not': return { keyword: 'not', message: 'must not match the schema declared in not' };
    case 'false schema': return { keyword: 'false', message: 'is not allowed here' };
    default: return { keyword: 'schema', message: 'does not satisfy the schema' };
  }
}

/**
 * Runs a compiled body validator and returns its failures as issues (at most `max`). Ajv stops at the first failing
 * keyword; when that is an `anyOf`/`oneOf`, the per-branch failures under it are folded into the one alternative issue.
 */
export function bodyIssues(compiled: CompiledBodySchema, value: unknown, max = 8): BodySchemaIssue[] {
  if (compiled.validate(value)) return [];
  const errors = compiled.validate.errors ?? [];
  const composites = errors.filter(error => error.keyword === 'anyOf' || error.keyword === 'oneOf').map(error => error.schemaPath + '/');
  const issues: BodySchemaIssue[] = [], seen = new Set<string>();
  for (const error of errors) {
    if (issues.length >= max) break;
    if (composites.some(prefix => error.schemaPath.startsWith(prefix))) continue;
    const issue = { pointer: issuePointer(error.instancePath, value, compiled.names), ...describe(error) };
    const key = JSON.stringify(issue);
    if (!seen.has(key)) { seen.add(key); issues.push(issue); }
  }
  return issues.length ? issues : [{ pointer: '', keyword: 'schema', message: 'does not satisfy the schema' }];
}
/** The plain-text line for an issue: array positions print as `[]` appended to the path, root as `/`. */
export const bodySchemaLine = (issue: BodySchemaIssue): string => `${issue.pointer.replace(/\/\[\]/g, '[]') || '/'} ${issue.message}`;

const maxIssueBytes = 4096;
/** Renders the JSON answer: never more than `maxIssueBytes`, dropping trailing issues and saying so. */
export function bodySchemaJson(issues: BodySchemaIssue[]): string {
  return bounded(issues, (list, truncated) => JSON.stringify({ error: 'body_validation_failed', message: 'Request body failed validation', ...(truncated ? { truncated } : {}), issues: list }));
}
/** The same answer in the JSON error envelope (`errors.format: json`), bounded the same way. */
export function bodySchemaEnvelope(issues: BodySchemaIssue[]): string {
  return bounded(issues, (list, truncated) => JSON.stringify({ error: { code: 'UNPROCESSABLE_CONTENT', message: 'Request body failed validation', ...(truncated ? { truncated } : {}), issues: list } }));
}
function bounded(issues: BodySchemaIssue[], shape: (list: BodySchemaIssue[], truncated: boolean) => string): string {
  let list = issues, text = shape(list, false);
  while (new TextEncoder().encode(text).length > maxIssueBytes && list.length) { list = list.slice(0, -1); text = shape(list, true); }
  return text;
}
