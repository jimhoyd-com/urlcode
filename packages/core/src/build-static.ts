import { analyzeProjectCapabilities, analyzeCompiledCapabilities, assertTargetCompatibility } from './capabilities.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { loadDocument } from './config.ts';
import { compileRoutes } from './router.ts';
import { compileAssets } from './assets.ts';
import { assert, ConfigError } from './errors.ts';
import { applySite } from './site.ts';
import { buildManifest, renderManifest, manifestPath } from './manifest.ts';
import type { LogFn } from './types.ts';

export interface BuildOptions { out?: string | undefined; origin?: string | undefined; log?: LogFn | undefined }
export interface BuildReport { out: string; format: number; version: string; routes: number; redirects: number; files: number; manifest: string }

// The manifests below are this target's own build output, not a published
// contract: their shape may change with any release.
const FORMAT = 1;

/** One S3 per-object website redirect: a zero-byte object at `key` carrying
 * `x-amz-website-redirect-location: location`, which S3 always answers with a
 * 301 regardless of the object's own metadata. */
export interface StaticRedirect { key: string; location: string; status: 301 }
/** One served file: the bytes are written under `out/objects/<key>`; the
 * metadata here is what a deploy step sets as the S3 object's own headers. */
export interface StaticObject { key: string; contentType: string; cacheControl?: string; contentDisposition?: string }
export interface RedirectManifest { format: number; redirects: StaticRedirect[] }
export interface ObjectManifest { format: number; objects: StaticObject[] }

// S3 static-website object keys never start with a slash; the bucket's own
// "Index document" suffix (conventionally index.html) is what answers a
// request for a folder path or the site root, exactly the same convention
// used here for pattern '/'.
function objectKey(pattern: string): string {
  const trimmed = pattern.slice(1);
  return trimmed === '' ? 'index.html' : trimmed;
}

export async function buildStatic(project: string, { out = 'dist/static', origin, log = () => {} }: BuildOptions = {}): Promise<BuildReport> {
  const loaded = await loadDocument(project);
  // Generated site routes are built like declared ones; the ones that need
  // an origin get it from --origin, exactly as the server does.
  await applySite(loaded, { origin, log });
  assertTargetCompatibility(analyzeProjectCapabilities(loaded, 'static'));
  const compiled = await compileRoutes(loaded, {}, {}, undefined);
  const routes = [...compiled.exact.values(), ...[...compiled.byLength.values()].flat(), ...compiled.mounts];

  assertTargetCompatibility(analyzeCompiledCapabilities(loaded.document, compiled, 'static'));
  assert(routes.length, 'No routes to build');

  // Capability analysis already refused function/middleware/extension,
  // parameters, request.body, response.headers, bindings, proxy/signals,
  // conditional/conditions and every policy for this target, so every
  // surviving route is a plain redirect/respond/page/static/download with no
  // path placeholders. What is left below are shapes capability analysis
  // cannot see because they are configuration, not capability, distinctions:
  // a redirect that needs request-time logic (query passthrough/mapping, a
  // non-301 status), and a route that needs request-time lifecycle checks
  // (`enabled: false`, `expires`) or a method other than GET/HEAD.
  const defaultMethods = new Set(['GET', 'HEAD']);
  for (const route of routes) {
    assert(route.enabled !== false, `${route.pattern}: static hosting has no server to answer a disabled route with 404; remove the route instead of disabling it`);
    assert(route.expiresAt === undefined, `${route.pattern}: static hosting has no server to answer an expired route with 410; remove the route when it expires`);
    assert(route.methods.every(method => defaultMethods.has(method)), `${route.pattern}: static hosting only ever answers GET/HEAD; this target refuses declared methods ${route.methods.join(', ')}`);
    assert(defaultMethods.size === route.methods.length && [...defaultMethods].every(method => route.methods.includes(method)), `${route.pattern}: static hosting cannot preserve a GET-only or HEAD-only method restriction; declare both GET and HEAD`);
    if (route.reply) assert(route.reply.status === 200, `${route.pattern}: static hosting serves response objects with status 200; declared status ${route.reply.status} cannot be preserved`);
    if (route.redirect) {
      assert(!route.wildcard, `${route.pattern}: static hosting cannot redirect a path suffix; S3 per-object redirects match one exact path`);
      assert(!route.names.length, `${route.pattern}: static hosting cannot redirect a path pattern; only an exact literal path can carry an S3 per-object redirect`);
      const query = route.redirect.query;
      assert(!query?.pass?.length && !(query?.map && Object.keys(query.map).length), `${route.pattern}: static hosting cannot pass or map query parameters into a redirect target; this needs request-time logic S3 does not have`);
      assert(!route.redirect.status || route.redirect.status === 301, `${route.pattern}: S3's per-object website redirect always answers 301; this route declares ${route.redirect.status}, which would silently change on this target`);
    }
  }

  await compileAssets(loaded.root, routes);

  const objectsDir = join(out, 'objects');
  await mkdir(objectsDir, { recursive: true });
  const redirects: StaticRedirect[] = [];
  const objects: StaticObject[] = [];
  const writeObject = async (key: string, body: Uint8Array): Promise<void> => {
    const target = join(objectsDir, ...key.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  };

  for (const route of routes) {
    if (route.redirect) {
      const key = objectKey(route.pattern);
      redirects.push({ key, location: route.redirect.url, status: 301 });
      await writeObject(key, new Uint8Array());
      continue;
    }
    if (route.static) {
      const asset = route.asset;
      assert(asset instanceof Map, `${route.pattern}: static mount has no compiled asset snapshot`);
      const prefix = route.prefix!.slice(1);
      for (const [name, file] of asset) {
        const key = prefix + name;
        objects.push({ key, contentType: file.type, cacheControl: file.cache });
        await writeObject(key, file.body);
      }
      continue;
    }
    if (route.page || route.download) {
      const asset = route.asset;
      assert(asset && !(asset instanceof Map), `${route.pattern}: route has no compiled asset snapshot`);
      const key = objectKey(route.pattern);
      objects.push({ key, contentType: asset.type, cacheControl: asset.cache, ...(asset.attachment ? { contentDisposition: asset.attachment } : {}) });
      await writeObject(key, asset.body);
      continue;
    }
    if (route.reply) {
      const key = objectKey(route.pattern);
      const contentType = route.reply.headers.find(([name]) => name === 'content-type')?.[1] ?? 'application/octet-stream';
      objects.push({ key, contentType });
      await writeObject(key, route.reply.body);
      continue;
    }
    // Unreachable: capability analysis already refuses every other handler for this target.
    throw new ConfigError(`${route.pattern}: static target has no compiler for this route`);
  }

  const redirectManifest: RedirectManifest = { format: FORMAT, redirects };
  const objectManifest: ObjectManifest = { format: FORMAT, objects };
  await writeFile(join(out, 'redirects.json'), JSON.stringify(redirectManifest, null, 2) + '\n');
  await writeFile(join(out, 'objects.json'), JSON.stringify(objectManifest, null, 2) + '\n');
  // The semantic manifest travels with the artifact so a reviewer can read
  // what was built without the project checkout (docs/TOOLING.md).
  const manifest = manifestPath(out);
  await writeFile(manifest, renderManifest(await buildManifest(project, origin === undefined ? {} : { origin })));
  return { out, format: FORMAT, version: loaded.version, routes: routes.length, redirects: redirects.length, files: objects.length, manifest };
}

// Exported for tests that need the exact key a route compiles to without
// duplicating the mapping rule.
export const staticObjectKey = objectKey;
