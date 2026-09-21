import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadDocument } from '../src/config.ts';
import { compileRoutes } from '../src/router.ts';
import { parseTarget, matchRoute, contextFor, redirectLocation } from '../src/match.ts';
import { buildStatic } from '../src/build-static.ts';
import { buildCloudflare } from '../src/build-cloudflare.ts';
import { exportRoutes } from '../src/interchange.ts';

// Agent-efficiency plan, phase 1 (#383): root-relative redirect destinations and the `/**` suffix wildcard.
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } };
async function table(routes: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-wildcard-'));
  await writeFile(join(root, 'urlcode.yaml'), stringify({ version: '1', routes }, { aliasDuplicateObjects: false }));
  return { root, compiled: await compileRoutes(await loadDocument(root), {}) };
}
async function locate(routes: Record<string, unknown>, target: string): Promise<string | number> {
  const { compiled } = await table(routes);
  const parsed = parseTarget(target);
  const match = matchRoute(compiled, parsed);
  if (!match?.route.redirect) return 404;
  return redirectLocation(match.route as typeof match.route & { redirect: NonNullable<typeof match.route.redirect> }, contextFor(match.route, match.path, parsed.query, new Headers()), parsed.query);
}
const routes = {
  '/users/{id}': { parameters: [idParam], redirect: { url: '/profiles/{id}' } },
  '/legacy/**': { redirect: { url: '/new/{**}' } },
  '/legacy/keep/{id}': { parameters: [idParam], redirect: { url: '/kept/{id}' } },
  '/old/**': { redirect: { url: 'https://example.com/modern/{**}?from=old', status: 301 } },
};

test('a root-relative destination redirects to a path and encodes the placeholder as one component', async () => {
  assert.equal(await locate(routes, '/users/42'), '/profiles/42');
  assert.equal(await locate(routes, '/users/a%20b'), '/profiles/a%20b');
});
test('a wildcard captures every remaining segment at any depth and encodes each one', async () => {
  assert.equal(await locate(routes, '/legacy/a'), '/new/a');
  assert.equal(await locate(routes, '/legacy/a/b/c/d/e/f/g/h/i/j'), '/new/a/b/c/d/e/f/g/h/i/j');
  assert.equal(await locate(routes, '/legacy/a%20b/c%3Fd'), '/new/a%20b/c%3Fd');
  assert.equal(await locate(routes, '/old/x/y'), 'https://example.com/modern/x/y?from=old');
});
test('a wildcard needs at least one clean segment and yields to a more specific route', async () => {
  for (const path of ['/legacy', '/legacy/', '/legacy/a//b', '/legacy/a/']) assert.equal(await locate(routes, path), 404, path);
  assert.equal(await locate(routes, '/legacy/keep/z'), '/kept/z');
  assert.equal(await locate(routes, `/legacy/${'a'.repeat(1025)}`), 404);
});
test('a captured value can never reach the host or add a segment', async () => {
  for (const path of ['/legacy/%2e%2e/x', '/legacy/%2f%2fevil.example', '/legacy/..%5cevil.example']) await assert.rejects(locate(routes, path), /Invalid/, path);
  const location = await locate(routes, '/legacy/evil.example');
  assert.equal(location, '/new/evil.example');
  assert.ok(typeof location === 'string' && location.startsWith('/') && !location.startsWith('//'));
});
test('destinations and wildcard keys that could escape or overlap are refused', async () => {
  const refused: [string, Record<string, unknown>, RegExp][] = [
    ['protocol-relative host', { '/a': { redirect: { url: '//evil.example/x' } } }, /absolute HTTP\(S\) URL or a root-relative path/],
    ['dot segment', { '/a': { redirect: { url: '/x/../y' } } }, /dot segments/],
    ['placeholder in relative query', { '/a/{id}': { parameters: [idParam], redirect: { url: '/x?q={id}' } } }, /only in path segments/],
    ['{**} without a wildcard route', { '/a': { redirect: { url: '/x/{**}' } } }, /declared path input/],
    ['{**} twice', { '/a/**': { redirect: { url: '/x/{**}/{**}' } } }, /once/],
    ['root wildcard', { '/**': { redirect: { url: '/x' } } }, /literal prefix/],
    ['wildcard with a parameter', { '/a/{id}/**': { parameters: [idParam], redirect: { url: '/x' } } }, /literal prefix|no path parameters/],
    ['wildcard on a non-redirect', { '/a/**': { respond: { text: 'x' } } }, /terminal \/\* wildcard/],
    ['single star on a redirect', { '/a/*': { redirect: { url: '/x' } } }, /terminal \/\* wildcard; a redirect uses/],
    ['mount and wildcard share a prefix', { '/a/**': { redirect: { url: '/x' } }, '/a/*': { static: { directory: 'public' } } }, /share its prefix/],
  ];
  for (const [name, config, message] of refused) await assert.rejects(table(config), message, name);
});
test('static hosting refuses a suffix redirect rather than changing its meaning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-wildcard-static-'));
  await writeFile(join(root, 'urlcode.yaml'), stringify({ version: '1', routes: { '/legacy/**': { redirect: { url: 'https://example.com/n/{**}', status: 301 } } } }));
  await assert.rejects(buildStatic(root, { out: join(root, 'out') }), /cannot redirect a path suffix/);
});
test('the Worker target and the provider exporters refuse what they cannot express', async () => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-wildcard-targets-'));
  await writeFile(join(root, 'urlcode.yaml'), stringify({ version: '1', routes: { '/legacy/**': { redirect: { url: '/new/{**}' } } } }));
  await assert.rejects(buildCloudflare(root, { out: join(root, 'out') }), /no suffix matching yet/);
  const document = (await loadDocument(root)).document;
  const report = await exportRoutes({ format: 'csv', document });
  assert.ok(report.diagnostics.some(item => item.severity === 'error' && item.code === 'runtime-required'), JSON.stringify(report.diagnostics));
});
