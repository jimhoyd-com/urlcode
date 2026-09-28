import Ajv from 'ajv/dist/2020.js';
import { ConfigError } from './errors.ts';
import { assertBodySchema, bodyIssues, bodySchemaAjvOptions, bodySchemaLine, declaredBodyNames, uuidFormat } from './body-validation.ts';
import type { BodySchema, BodySchemaIssue, BodyValidator, CompiledBodySchema } from './body-validation.ts';

// Also published as the public `@jimhoyd/urlcode/body-schema` subpath: an operator-installed extension
// (docs/EXTENSIONS.md) that declares its own bounded per-request input contract (for example a tool's
// `arguments`) validates against exactly the profile `request.body.<METHOD>.schema` uses, compiled by the same Ajv
// options, instead of hand-rolling or configuring a second JSON Schema engine. This module compiles with Ajv,
// which generates code, so it runs on Node hosts only; the Cloudflare Worker imports body-validation.ts and
// receives build-time standalone validators instead (build-cloudflare.ts).
export { assertBodySchema, bodyIssues, bodySchemaDialect, bodySchemaEnvelope, bodySchemaJson, bodySchemaLine, bodySchemaProfile, declaredBodyNames, maxRequestBodyBytes, uuidFormat } from './body-validation.ts';
export type { BodySchema, BodySchemaIssue, BodySchemaType, BodyValidator, CompiledBodySchema } from './body-validation.ts';

let ajv: InstanceType<typeof Ajv.default> | undefined;
const compiledSchemas = new WeakMap<object, CompiledBodySchema>();
/**
 * Checks `schema` against the supported JSON Schema 2020-12 profile and compiles it once (cached per schema object).
 * Local `#/$defs` references only: the Ajv instance has no `loadSchema`, so nothing is ever fetched.
 */
export function compileBodySchema(schema: unknown): CompiledBodySchema {
  if (typeof schema === 'object' && schema !== null) { const cached = compiledSchemas.get(schema); if (cached) return cached; }
  assertBodySchema(schema);
  if (!ajv) {
    // Node hands the CJS module.exports (the class) to a default import; TypeScript types it as the namespace, whose .default is the same class.
    ajv = new Ajv.default({ ...bodySchemaAjvOptions });
    ajv.addFormat('uuid', uuidFormat);
  }
  let validate: BodyValidator;
  try { validate = ajv.compile(schema) as BodyValidator; }
  catch (error) { throw new ConfigError(`Body schema: refused by the JSON Schema 2020-12 validator: ${String((error as Error).message).slice(0, 200)}`, {}, { cause: error }); }
  // The compiled function stands alone; dropping Ajv's strong cache entry keeps a reloaded project's old schemas collectable.
  finally { ajv.removeSchema(schema); }
  const compiled: CompiledBodySchema = { validate, names: declaredBodyNames(schema) };
  compiledSchemas.set(schema, compiled);
  return compiled;
}
/** Structured failures of `value` against `schema` (compiled on first use); `checkBodySchema` renders them as text. */
export function bodySchemaIssues(schema: BodySchema, value: unknown, max?: number): BodySchemaIssue[] {
  return bodyIssues(compileBodySchema(schema), value, max);
}
/**
 * Returns fixed-wording failures for `value`, each naming only a path the schema itself declared (array positions
 * appear as `[]`). Nothing the client sent is echoed, so the answer stays safe to render as plain text.
 */
export function checkBodySchema(schema: BodySchema, value: unknown): string[] {
  return bodySchemaIssues(schema, value).map(bodySchemaLine);
}
