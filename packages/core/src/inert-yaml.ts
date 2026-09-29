import { LineCounter, isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { ConfigError } from './errors.ts';

/**
 * The YAML profile for third-party inert documents only (#857): the JSON, YAML and Markdown data an artifact package
 * ships, read by `artifacts add` (inertness) and `artifacts inspect`. Never used for project YAML, which keeps the
 * runtime profile in config.ts (no anchors, aliases, merge keys or tags).
 *
 * Real-world OpenAPI and schema documents share fragments with anchors, aliases and `<<` merge keys, so this profile
 * allows them, bounded: explicit tags and directives are refused, the alias count is capped, a recursive alias is
 * refused, and the document's size and nesting are measured as if every alias were expanded, before anything is
 * built. The expanded size is capped both relative to the input and absolutely, so a billion-laughs document is
 * refused without ever being expanded. Messages carry positions, never document content.
 */
export const inertYamlLimits = {
  /** Largest input, the artifact per-file limit. */
  maxInputBytes: 2 * 1024 * 1024,
  /** Most alias nodes (including those inside `<<` merge keys) in one document. */
  maxAliasCount: 1024,
  /** Largest expanded size relative to the input: at most this many times the input bytes… */
  maxExpansionRatio: 10,
  /** …and never more than this, whatever the input. */
  maxExpandedBytes: 16 * 1024 * 1024,
  /** Deepest map/sequence nesting after expansion. */
  maxNesting: 256,
} as const;
export type InertYamlLimits = { [K in keyof typeof inertYamlLimits]: number };

interface Measure { bytes: number; height: number }
const refuse = (message: string, at?: { line: number; col: number }): never => {
  throw new ConfigError(`${message}${at ? ` at line ${at.line}, column ${at.col}` : ''}`, { code: 'invalid-yaml', line: at?.line, column: at?.col });
};

/** Parses one inert third-party YAML document under this profile; returns JSON-compatible data or throws ConfigError. */
export function parseInertYaml(text: string, limits: InertYamlLimits = inertYamlLimits): unknown {
  const input = Buffer.byteLength(text);
  if (input > limits.maxInputBytes) refuse(`YAML document is ${input} bytes, over the ${limits.maxInputBytes}-byte limit`);
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: false, strict: true, merge: true, lineCounter });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    // Only the parser's fixed first sentence: the excerpt it appends may hold document content.
    const reason = (problem.message.split(/ at line \d+|\n/)[0] ?? '').slice(0, 160);
    const start = problem.linePos?.[0];
    refuse(`Invalid YAML: ${reason} (${problem.code})`, start);
  }
  const at = (node: unknown): { line: number; col: number } | undefined => {
    const offset = isNode(node) ? node.range?.[0] : undefined;
    return offset === undefined ? undefined : lineCounter.linePos(offset);
  };
  if (doc.directives?.yaml.explicit || Object.keys(doc.directives?.tags ?? {}).some(handle => handle !== '!' && handle !== '!!')) refuse('YAML directives are not allowed in an inert document');
  const cap = Math.min(limits.maxExpandedBytes, limits.maxExpansionRatio * Math.max(input, 1));
  measure(doc, limits, cap, at);
  return doc.toJS({ maxAliasCount: -1, mapAsMap: false });
}

/**
 * Walks the document once in order, measuring each collection's expanded JSON size and height; an alias reuses its
 * anchor's measure, so the walk is linear in the source however much the aliases would expand.
 */
function measure(doc: Document, limits: InertYamlLimits, cap: number, at: (node: unknown) => { line: number; col: number } | undefined): void {
  const done = new Map<unknown, Measure>(), open = new Set<unknown>();
  let aliases = 0;
  const tooBig = (bytes: number, node: unknown): void => { if (bytes > cap) refuse(`YAML document would expand to more than ${cap} bytes (${limits.maxExpansionRatio} times its size, at most ${limits.maxExpandedBytes})`, at(node)); };
  const tooDeep = (node: unknown): never => refuse(`YAML document nests deeper than ${limits.maxNesting} levels once its aliases are expanded`, at(node));
  const walk = (node: unknown, depth: number): Measure => {
    if (node === null || node === undefined) return { bytes: 4, height: 0 };
    if (isAlias(node)) {
      if (++aliases > limits.maxAliasCount) refuse(`YAML document has more than ${limits.maxAliasCount} aliases`, at(node));
      const source = node.resolve(doc);
      if (source === undefined) refuse('YAML alias has no anchor', at(node));
      if (open.has(source)) refuse('YAML alias refers to a collection that contains it (a recursive alias)', at(node));
      const found = done.get(source) ?? walk(source, depth);
      if (depth + found.height > limits.maxNesting) tooDeep(node);
      return found;
    }
    if (isNode(node) && node.tag) refuse('YAML explicit tags are not allowed in an inert document', at(node));
    if (isScalar(node)) {
      const value = node.value;
      if (typeof value === 'number' && !Number.isFinite(value)) refuse('Non-finite YAML number', at(node));
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) refuse('Non-JSON YAML value', at(node));
      return { bytes: typeof value === 'string' ? Buffer.byteLength(value) + 2 : String(value).length, height: 0 };
    }
    if (!isMap(node) && !isSeq(node)) return refuse('Unsupported YAML node', at(node));
    if (depth >= limits.maxNesting) tooDeep(node);
    open.add(node);
    let bytes = 2, height = 0;
    const add = (child: Measure): void => { bytes += child.bytes + 1; height = Math.max(height, child.height); tooBig(bytes, node); };
    if (isMap(node)) {
      const keys = new Set<string>();
      for (const pair of node.items) {
        const key = pair.key;
        // A `<<` merge key parses as a scalar holding no value; its entries are measured through its value.
        const merge = isScalar(key) && !key.tag && typeof key.value === 'symbol' && key.source === '<<';
        if (!merge && (!isScalar(key) || key.tag || key.value === null || !['string', 'number', 'boolean'].includes(typeof key.value))) refuse('YAML mapping keys must be strings, numbers or booleans', at(key));
        const name = merge ? '<<' : String((key as { value: unknown }).value);
        if (name === '__proto__') refuse('Reserved YAML mapping key', at(key));
        if (keys.has(name) && name !== '<<') refuse('Duplicate YAML mapping key', at(key));
        keys.add(name);
        add({ bytes: Buffer.byteLength(name) + 3, height: 0 });
        add(walk(pair.value, depth + 1));
      }
    } else for (const item of node.items) add(walk(item, depth + 1));
    open.delete(node);
    const result = { bytes, height: height + 1 };
    done.set(node, result);
    return result;
  };
  const total = walk(doc.contents, 0);
  tooBig(total.bytes, doc.contents);
}
