// The description gate every generated field reference shares (#750 for core's
// schemas/urlcode.schema.json, #822 for each first-party extension's
// configuration, route-policy and hook schemas). A property is a key under
// `properties` or `patternProperties`; `$defs` entries are containers, not keys
// an author writes. Every subschema keyword is walked, so properties inside
// $defs, map values, array items, anyOf/oneOf branches and `not` are covered
// too. Pointers are RFC 6901.
const MAP_KEYWORDS = ['properties', 'patternProperties', '$defs'];
const ONE_KEYWORDS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'];
const LIST_KEYWORDS = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];

/** JSON pointers of every declared property under `node` that has no non-empty `description`. */
export function undescribed(node: unknown, pointer = '', missing: string[] = []): string[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return missing;
  const record = node as Record<string, unknown>;
  for (const keyword of MAP_KEYWORDS) {
    const map = record[keyword];
    if (!map || typeof map !== 'object') continue;
    for (const [name, child] of Object.entries(map as Record<string, unknown>)) {
      const at = `${pointer}/${keyword}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      const description = child && typeof child === 'object' ? (child as { description?: unknown }).description : undefined;
      if (keyword !== '$defs' && (typeof description !== 'string' || !description.trim())) missing.push(at);
      undescribed(child, at, missing);
    }
  }
  for (const keyword of ONE_KEYWORDS) undescribed(record[keyword], `${pointer}/${keyword}`, missing);
  for (const keyword of LIST_KEYWORDS) {
    const list = record[keyword];
    if (Array.isArray(list)) for (const [index, child] of list.entries()) undescribed(child, `${pointer}/${keyword}/${index}`, missing);
  }
  return missing;
}

/** JSON pointers of every declared property under `node`, described or not, in the same walk as `undescribed`. */
export function propertyPointers(node: unknown, pointer = '', found: string[] = []): string[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return found;
  const record = node as Record<string, unknown>;
  for (const keyword of MAP_KEYWORDS) {
    const map = record[keyword];
    if (!map || typeof map !== 'object') continue;
    for (const [name, child] of Object.entries(map as Record<string, unknown>)) {
      const at = `${pointer}/${keyword}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (keyword !== '$defs') found.push(at);
      propertyPointers(child, at, found);
    }
  }
  for (const keyword of ONE_KEYWORDS) propertyPointers(record[keyword], `${pointer}/${keyword}`, found);
  for (const keyword of LIST_KEYWORDS) {
    const list = record[keyword];
    if (Array.isArray(list)) for (const [index, child] of list.entries()) propertyPointers(child, `${pointer}/${keyword}/${index}`, found);
  }
  return found;
}
