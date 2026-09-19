import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatic, staticObjectKey } from '../src/build-static.ts';
import { analyzeProjectCapabilities } from '../src/capabilities.ts';
import { loadDocument } from '../src/config.ts';
import { project, redirect, param } from './helpers.ts';
import type { ProjectFiles, ProjectSettings } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { RouteConfig } from '../src/types.ts';
import type { RedirectManifest, ObjectManifest } from '../src/build-static.ts';

async function build(t: TestContext, root: string) {
  const out = await mkdtemp(join(tmpdir(), 'urlcode-static-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const report = await buildStatic(root, { out });
  return { report, out };
}
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

test('the static target refuses function/middleware the same way Cloudflare does', () => {
  const withFunction = analyzeProjectCapabilities({ document: { version: '1', routes: {
    '/f': { function: { source: 'f.mjs' } } } }, routes: { '/f': { function: { source: 'f.mjs' } } }, root: '/none', files: [], version: '1' }, 'static');
  assert.equal(withFunction.compatible, false);
  const functionIssue = withFunction.issues.find(item => item.capability === 'function');
  assert.equal(functionIssue?.support, 'refused');
  assert.match(functionIssue!.reason, /no server, so no dynamic execution/);

  const withMiddleware = analyzeProjectCapabilities({ document: { version: '1', routes: {} }, routes: {
    '/m': { ...redirect(), middleware: [{ source: 'm.mjs' }] } }, root: '/none', files: [], version: '1' }, 'static');
  const middlewareIssue = withMiddleware.issues.find(item => item.capability === 'middleware');
  assert.equal(middlewareIssue?.support, 'refused');
  assert.match(middlewareIssue!.reason, /no server/);
});

test('page/static/download/redirect/respond are supported by the static target', async t => {
  const root = await project(t, { '/go': redirect() });
  const report = analyzeProjectCapabilities(await loadDocument(root), 'static');
  assert.equal(report.compatible, true);
});

test('a mixed project compiles redirects, files and refuses the function route', async t => {
  const root = await project(t, {
    '/go': redirect('https://example.com/target'),
    '/hello': { respond: { text: 'hi there' } },
    '/about': { page: { file: 'about.html' } },
    '/assets/*': { static: { directory: 'public', index: 'index.html' } },
    '/checkout': { function: { source: 'f.mjs' } },
  }, {
    'about.html': '<p>about</p>',
    'public/index.html': '<p>home</p>',
    'public/css/site.css': 'body{color:red}',
    'f.mjs': 'export default () => new Response("x");',
  });
  await assert.rejects(() => buildStatic(root, { out: join(tmpdir(), 'urlcode-static-never') }), /no server, so no dynamic execution/);
});

test('a static-only project builds an S3/CloudFront-shaped artifact', async t => {
  const root = await project(t, {
    '/go': redirect('https://example.com/target'),
    '/hello': { respond: { text: 'hi there' } },
    '/about': { page: { file: 'about.html' } },
    '/assets/*': { static: { directory: 'public', index: 'index.html' } },
  }, {
    'about.html': '<p>about</p>',
    'public/index.html': '<p>home</p>',
    'public/css/site.css': 'body{color:red}',
  });
  const { report, out } = await build(t, root);
  assert.equal(report.routes, 4);
  assert.equal(report.redirects, 1);
  assert.equal(report.files, 4); // about, hello, public/index.html, public/css/site.css

  const redirects = await readJson<RedirectManifest>(join(out, 'redirects.json'));
  assert.deepEqual(redirects.redirects, [{ key: 'go', location: 'https://example.com/target', status: 301 }]);
  assert.equal(await readFile(join(out, 'objects', 'go'), 'utf8'), '');

  const objects = await readJson<ObjectManifest>(join(out, 'objects.json'));
  const byKey = Object.fromEntries(objects.objects.map(o => [o.key, o]));
  assert.ok(byKey['about']);
  assert.equal(byKey['about']!.contentType, 'text/html; charset=utf-8');
  assert.equal(await readFile(join(out, 'objects', 'about'), 'utf8'), '<p>about</p>');
  assert.ok(byKey['assets/index.html']);
  assert.ok(byKey['assets/css/site.css']);
  assert.equal(await readFile(join(out, 'objects', 'assets', 'css', 'site.css'), 'utf8'), 'body{color:red}');
  assert.ok(byKey['hello']);
  assert.equal(await readFile(join(out, 'objects', 'hello'), 'utf8'), 'hi there');

  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { routeCount: number };
  assert.equal(manifest.routeCount, 4);
});

test('the root path compiles to index.html, matching an S3 index document', async t => {
  const root = await project(t, { '/': { respond: { text: 'root' } } });
  const { out } = await build(t, root);
  const objects = await readJson<ObjectManifest>(join(out, 'objects.json'));
  assert.deepEqual(objects.objects.map(o => o.key), ['index.html']);
  assert.equal(staticObjectKey('/'), 'index.html');
  assert.equal(staticObjectKey('/about'), 'about');
});

test('redirect shapes that need request-time logic are refused at build time, not silently dropped', async t => {
  const cases: [RouteConfig, RegExp][] = [
    [{ ...redirect(), enabled: false }, /disabled route/],
    [{ ...redirect(), expires: '2020-01-01T00:00:00Z' }, /expired route/],
    [{ ...redirect(), methods: ['POST'] }, /only ever answers GET\/HEAD/],
    [{ redirect: { url: 'https://example.com/target', status: 302 } }, /always answers 301/],
    [{ redirect: { url: 'https://example.com/target', query: { pass: ['q'] } } }, /pass or map query parameters/],
    [{ parameters: [param('id')], redirect: { url: 'https://example.com/{id}' } }, /parameters/],
  ];
  for (const [config, expected] of cases) {
    const pattern = config.parameters ? '/u/{id}' : '/go';
    const settings: ProjectSettings = {};
    const files: ProjectFiles = {};
    const projectRoot = await project(t, { [pattern]: config }, files, settings);
    await assert.rejects(() => buildStatic(projectRoot, { out: join(tmpdir(), 'urlcode-static-never') }), expected);
  }
});

test('a project with nothing to serve fails the build rather than shipping an empty bucket', async t => {
  const root = await project(t, {});
  await assert.rejects(() => buildStatic(root, { out: join(tmpdir(), 'urlcode-static-never') }), /No routes/);
});


test('static export refuses response status and method restrictions it cannot preserve', async t => {
  for (const [route, expected] of [
    [{respond: {status: 201, text: 'created'}}, /status 201 cannot be preserved/],
    [{respond: {status: 404, text: 'missing'}}, /status 404 cannot be preserved/],
    [{respond: {text: 'head'}, methods: ['HEAD']}, /declare both GET and HEAD/],
    [{respond: {text: 'get'}, methods: ['GET']}, /declare both GET and HEAD/],
  ] as [RouteConfig, RegExp][]) {
    const root = await project(t, {'/response': route});
    await assert.rejects(buildStatic(root, {out: join(tmpdir(), 'urlcode-static-refused')}), expected);
  }
});
