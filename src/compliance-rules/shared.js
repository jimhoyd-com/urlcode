import { profiles as securityProfiles } from '../policies/security.js';

// Facts every rule module reads the same way. Nothing here guesses: each
// helper reads the YAML route configuration, the runtime's test plan or the
// effective policy the runtime compiled from that YAML.
export const oshp = Object.freeze({ name: 'OWASP Secure Headers Project', reference: 'https://owasp.org/www-project-secure-headers/', section: 'Best practices' });
export const rfc9111 = Object.freeze({ name: 'RFC 9111 HTTP Caching', reference: 'https://www.rfc-editor.org/rfc/rfc9111', section: '5.2 Cache-Control' });
export const rfc9110 = Object.freeze({ name: 'RFC 9110 HTTP Semantics', reference: 'https://www.rfc-editor.org/rfc/rfc9110' });
export const rfc6585 = Object.freeze({ name: 'RFC 6585 Additional HTTP Status Codes', reference: 'https://www.rfc-editor.org/rfc/rfc6585', section: '4. 429 Too Many Requests' });
export const rfc9309 = Object.freeze({ name: 'RFC 9309 Robots Exclusion Protocol', reference: 'https://www.rfc-editor.org/rfc/rfc9309' });
export const breach = Object.freeze({ name: 'BREACH (compression side channel)', reference: 'https://www.breachattack.com/', section: 'Mitigations' });
export const monitoring = Object.freeze({ name: 'URLCode logging guarantees', reference: 'docs/MONITORING.md', section: 'Log records' });
export const linkChannel = Object.freeze({ name: 'URLCode link event channel', reference: 'docs/MONITORING.md', section: 'The link event channel' });
export const management = Object.freeze({ name: 'URLCode management security', reference: 'docs/MANAGEMENT-SECURITY.md' });
export const agentLists = Object.freeze({ name: 'URLCode bundled agent lists', reference: 'docs/policies/agents.md', section: 'Bundled lists' });

export const active = route => route.state === 'active';
export const functionLike = route => route.handler === 'function' || route.middleware > 0;
export const hasSecrets = config => Object.keys(config?.secrets ?? {}).length > 0;

// YAML response header by name, case-insensitive; Set-Cookie may be an array.
export function yamlHeader(config, name) {
  const key = name.toLowerCase();
  for (const [header, value] of Object.entries(config?.response?.headers ?? {})) if (header.toLowerCase() === key) return value;
  return undefined;
}
export function yamlHeaderBytes(config) {
  let size = 0;
  for (const [name, value] of Object.entries(config?.response?.headers ?? {})) for (const item of Array.isArray(value) ? value : [value]) size += Buffer.byteLength(name + String(item));
  return size;
}
// Asset handlers carry their Cache-Control on the handler (src/assets.js
// defaults it to no-cache when absent).
export function handlerCacheControl(config) {
  for (const key of ['page','static','download']) if (config?.[key]) return { declared: config[key].cacheControl !== undefined, value: config[key].cacheControl ?? 'no-cache' };
  return null;
}
export const directive = (value, token) => new RegExp(`(?:^|,)\\s*${token}\\s*(?:=|,|$)`, 'i').test(String(value ?? ''));

// The header names a route's security policy emits, computed the way
// src/policies/security.js compiles them: profile table minus `unset`, plus
// `set`. The runtime's describe map is preferred when the plan carries it.
export function emittedSecurityHeaders(effective, policy) {
  if (policy?.security?.emits) return new Set([...policy.security.emits, ...(policy.security.set ?? [])]);
  const config = effective?.security;
  if (!config) return new Set();
  const table = new Set((securityProfiles[config.headers ?? 'oshp'] ?? []).map(([key]) => key));
  for (const raw of config.unset ?? []) table.delete(String(raw).toLowerCase());
  for (const raw of Object.keys(config.set ?? {})) table.add(raw.toLowerCase());
  return table;
}
export function securityHeaderBytes(effective, policy) {
  if (typeof policy?.security?.bytes === 'number') return policy.security.bytes;
  const config = effective?.security;
  if (!config) return 0;
  const unset = new Set((config.unset ?? []).map(raw => String(raw).toLowerCase()));
  const set = Object.entries(config.set ?? {});
  const kept = (securityProfiles[config.headers ?? 'oshp'] ?? []).filter(([key]) => !unset.has(key) && !set.some(([raw]) => raw.toLowerCase() === key));
  return [...kept, ...set].reduce((n, [key, value]) => n + Buffer.byteLength(key + value), 0);
}
