// Review facts for the operator: the pinned Better Auth package and every endpoint of this instance, probed
// through its own handler rather than taken from documentation. Read-only; makes no network request.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import { authOptions, basePath, enabledPaths } from '../operator/auth.mjs';

const site = fileURLToPath(new URL('..', import.meta.url));
const origin = process.env.SITE_ORIGIN ?? 'http://localhost:4180';
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const locked = Object.entries(lock.packages).filter(([path]) => path.startsWith('node_modules/') && !lock.packages[path].dev);
// Probing unconfigured flows makes Better Auth log errors; they are expected here.
const auth = betterAuth({ ...authOptions({ site, origin }), logger: { disabled: true } });
const endpoints = [];
for (const [name, endpoint] of Object.entries(auth.api)) {
  const methods = [endpoint.options?.method ?? []].flat();
  if (!endpoint.path) { endpoints.push({ name, path: null, methods, served: false, note: 'server API only, no HTTP route' }); continue; }
  const path = endpoint.path.replaceAll(/:[a-z]+/gi, 'probe');
  const response = await auth.handler(new Request(origin + basePath + path, { method: methods[0] ?? 'GET', headers: { origin } }));
  const routed = response.status !== 404, forwarded = enabledPaths.includes(endpoint.path);
  // Served only when the adapter forwards the exact path and Better Auth itself still routes it.
  endpoints.push({ name, path: basePath + endpoint.path, methods, betterAuth: routed ? 'routed' : 'disabled', mount: forwarded ? 'forwarded' : 'refused', served: routed && forwarded });
}
const served = endpoints.filter(entry => entry.served).map(entry => entry.path.slice(basePath.length));
console.log(JSON.stringify({
  provider: Object.fromEntries(['better-auth', '@better-auth/core'].map(name => [name, { version: lock.packages[`node_modules/${name}`]?.version, integrity: lock.packages[`node_modules/${name}`]?.integrity, license: lock.packages[`node_modules/${name}`]?.license }])),
  runtimePackages: locked.length,
  mount: `${basePath}/*`,
  plugins: auth.options.plugins?.map(plugin => plugin.id) ?? [],
  endpoints,
  // Endpoints a plugin adds outside auth.api would not appear above; this instance registers no plugins.
  servedMatchesOperatorList: JSON.stringify([...served].sort()) === JSON.stringify([...enabledPaths].sort()),
}, null, 2));
