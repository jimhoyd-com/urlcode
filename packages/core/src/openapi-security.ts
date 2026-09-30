/**
 * The standard OpenAPI 3.1 security scheme a principal-providing extension may declare for the credential its
 * `authorize()` verifies (RIM-OPENAPI-001, #1047): `openapiSecurity` on its `defineExtension` definition (and so its
 * `urlcode.json`) and on the registration its `host()` returns. JSON data only, and never a credential: it names how a
 * client presents one (a header, query or cookie name, or an HTTP authentication scheme), never a value. The OpenAPI
 * export writes a complete declaration as the provider's `components.securitySchemes` entry.
 *
 * `apiKey` in a cookie may leave `name` out: the operator's configuration names that cookie, and the export never
 * publishes operator configuration, so it states the transport under `x-urlcode` instead of inventing a name.
 */
export type ExtensionOpenApiSecurity =
  | { type: 'http'; scheme: string; bearerFormat?: string; description?: string }
  | { type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string; description?: string }
  | { type: 'apiKey'; in: 'cookie'; name?: undefined; description?: string }
  | { type: 'mutualTLS'; description?: string };
/** The bounds of a declared scheme's strings, in characters. */
export const extensionOpenApiSecurityLimits = Object.freeze({ name: 128, scheme: 64, bearerFormat: 64, description: 512 });

/** An RFC 9110 token: what a header name, a cookie name and an HTTP authentication scheme are made of. */
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const keys: Record<string, readonly string[]> = { http: ['type', 'scheme', 'bearerFormat', 'description'], apiKey: ['type', 'in', 'name', 'description'], mutualTLS: ['type', 'description'] };
const bounded = (value: unknown, limit: number, pattern?: RegExp): boolean => typeof value === 'string' && value.length > 0 && value.length <= limit && (pattern ? pattern.test(value) : !/[\u0000-\u001f\u007f]/.test(value));

/** Why `value` is not a declared scheme within the contract, or undefined when it is one. */
export function openApiSecurityProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return 'openapiSecurity must be a plain object';
  const scheme = value as Record<string, unknown>, allowed = typeof scheme.type === 'string' && Object.hasOwn(keys, scheme.type) ? keys[scheme.type]! : undefined;
  if (!allowed) return `openapiSecurity type must be one of ${Object.keys(keys).join(', ')}`;
  const extra = Object.keys(scheme).find(key => !allowed.includes(key));
  if (extra !== undefined) return `openapiSecurity of type ${String(scheme.type)} holds only ${allowed.join(', ')}; ${extra.slice(0, 64)} is not one`;
  const limits = extensionOpenApiSecurityLimits;
  if (scheme.description !== undefined && !bounded(scheme.description, limits.description)) return `openapiSecurity description must be text of at most ${limits.description} characters`;
  if (scheme.type === 'http') {
    if (!bounded(scheme.scheme, limits.scheme, token)) return `openapiSecurity scheme must be an HTTP authentication scheme name (a token of at most ${limits.scheme} characters), such as bearer`;
    if (scheme.bearerFormat !== undefined && !bounded(scheme.bearerFormat, limits.bearerFormat, /^[\x20-\x7e]+$/)) return `openapiSecurity bearerFormat must be printable ASCII of at most ${limits.bearerFormat} characters`;
    if (scheme.bearerFormat !== undefined && String(scheme.scheme).toLowerCase() !== 'bearer') return 'openapiSecurity bearerFormat applies only to the bearer scheme';
  }
  if (scheme.type === 'apiKey') {
    if (scheme.in !== 'header' && scheme.in !== 'query' && scheme.in !== 'cookie') return 'openapiSecurity in must be header, query or cookie';
    if (scheme.name === undefined) { if (scheme.in !== 'cookie') return `openapiSecurity needs the ${scheme.in} name`; }
    else if (!bounded(scheme.name, limits.name, token)) return `openapiSecurity name must be a token of at most ${limits.name} characters`;
  }
  return undefined;
}
