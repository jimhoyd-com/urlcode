import { assert } from '../errors.js';

// STUB: replace with the full implementation. Contract in src/policies.js.
export const name = 'security';
export const phases = ['response'];
export function targets() { return { node:'native', vercel:'native', aws:'native', cloudflare:'compiled' }; }
export async function compile(config, { route }) {
  assert(config && typeof config === 'object', `policies.${name} on ${route.pattern} must be an object`);
  return { config };
}
export function onResponse(state, request, result) { return result; }
export function describe(state) { return { ...state.config }; }
export async function close() {}
