import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, mkdir, readdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';
import {prerenderPages, assertNativeProject, pageFileName, assertLiteralRoutePath} from '../src/prerender.ts';
import {prerender} from '../examples/prerender/prerender.mjs';
import {runProjectTests} from '../src/project-tests.ts';
import {createRuntime} from '../src/runtime.ts';
import {validateDocument} from '../src/config.ts';
import {project} from './helpers.ts';
import type {ProjectFiles} from './helpers.ts';
import type {TestContext} from 'node:test';
import type {RouteConfig} from '../src/types.ts';


const recipe = fileURLToPath(new URL('../examples/prerender', import.meta.url));
const output = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-prerender-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return join(directory, 'dist');
};
// A page rendered by a function through middleware, the shape the helper renders.
const html = (body: string) => `export default (request, {args}) => new Response(${body}, {headers: {'content-type': 'text/html; charset=utf-8'}});`;
const site = (routes: Record<string, string>, source = html('`<p>${args.title}</p>`')): {routes: Record<string, RouteConfig>; files: ProjectFiles} => ({
  routes: Object.fromEntries(Object.entries(routes).map(([path, title]) =>
    [path, {middleware: [{source: 'middleware/t.mjs'}], function: {source: 'functions/p.mjs', args: {title}}}])),
  files: {'functions/p.mjs': source, 'middleware/t.mjs': 'export default async (request, context, next) => next();'},
});
const build = async (t: TestContext, routes: Record<string, string>, source?: string) => { const {routes: r, files} = site(routes, source); return project(t, r, files); };

test('the example project serves the same pages dynamically and prerendered', async t => {
  const dist = await output(t);
  const report = await prerender(recipe, dist);
  assert.equal(report.pages, 3);
  assert.ok(report.bytes > 0);
  assert.deepEqual(await runProjectTests(recipe), {total: 7, failed: 0});
  assert.deepEqual(await runProjectTests(dist), {total: 6, failed: 0});
  const page = await readFile(join(dist, 'public', 'about.html'), 'utf8');
  // The shared template was applied, and page data cannot inject markup.
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>About &amp; &quot;quoting&quot;<\/title>/);
  assert.ok(!page.includes('About & "quoting"'));
});

test('the assembled project is inert: native pages only, no guest execution', async t => {
  const dist = await output(t);
  await prerender(recipe, dist);
  const document = validateDocument(parse(await readFile(join(dist, 'urlcode.yaml'), 'utf8')));
  assert.deepEqual(Object.keys(document.routes), ['/', '/guide', '/about']);
  for (const route of Object.values(document.routes)) assert.deepEqual(Object.keys(route), ['page']);
  const runtime = await createRuntime(dist, {log: () => {}});
  t.after(() => runtime.close());
  assert.ok(runtime.testPlan().inventory.every(route => route.handler === 'page' && route.middleware === 0));
});

test('the recipe runs when reached through a symlinked path', async t => {
  // macOS temporary directories are symlinked (/var -> /private/var), and Node
  // resolves a module's own URL through symlinks. A main-module check against a
  // raw argv[1] silently exits 0 without rendering anything.
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-prerender-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const link = join(directory, 'link');
  await symlink(recipe, link, 'dir');
  const dist = join(directory, 'out');
  const run = spawnSync(process.execPath, [...process.execArgv, join(link, 'prerender.mjs'), recipe, dist], {encoding: 'utf8', timeout: 60000});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"pages":3/);
  assert.deepEqual((await readdir(join(dist, 'public'))).sort(), ['about.html', 'guide.html', 'index.html']);
  assert.deepEqual(await runProjectTests(dist), {total: 6, failed: 0});
});

test('route paths map to one deterministic flat filename, injectively', () => {
  assert.equal(pageFileName('/'), 'index.html');
  assert.equal(pageFileName('/guide'), 'guide.html');
  // The separator cannot occur in a segment, so these three stay distinct.
  assert.equal(pageFileName('/a/b'), 'a~b.html');
  assert.equal(pageFileName('/a-b'), 'a-b.html');
  assert.equal(pageFileName('/a_b'), 'a_b.html');
  // Docs source URLs carry dots, underscores and mixed case.
  assert.equal(pageFileName('/docs/ASSETS.md'), 'docs~ASSETS.md.html');
  assert.equal(pageFileName('/examples/cookbook/routes/files.yaml'), 'examples~cookbook~routes~files.yaml.html');
  // '/' and a literal '/index' would otherwise claim the same file.
  assert.equal(pageFileName('/index'), 'index~.html');
  assert.notEqual(pageFileName('/index'), pageFileName('/'));
  const paths = ['/', '/index', '/a/b', '/a-b', '/a_b', '/a/b/c', '/a', '/b'];
  assert.equal(new Set(paths.map(pageFileName)).size, paths.length);
  // The separator is rejected inside a segment, which is what makes the
  // mapping injective: no route can claim a name the joiner produces.
  for (const path of ['/a~b', '/{code}', '/assets/*', '/../escape', '/a/../b', '/.', '/a//b', '/a b', 'relative'])
    assert.throws(() => pageFileName(path), /nonliteral route|must be absolute/, `accepted ${path}`);
});

test('renders preserve exact UTF-8 bytes and emit byte-for-byte GET and empty HEAD fixtures', async t => {
  const dist = await output(t);
  const text = 'Ünïcøde — 日本語 — 🎯 —  nbsp';
  const source = await build(t, {'/utf8': text});
  const result = await prerenderPages(source, dist);
  const expected = `<p>${text}</p>`;
  // The file on disk and the fixture agree byte for byte with what was rendered.
  const bytes = await readFile(join(dist, 'utf8.html'));
  assert.equal(bytes.toString('utf8'), expected);
  assert.equal(bytes.length, Buffer.byteLength(expected));
  assert.equal(result.pages[0]?.bytes, bytes.length);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(result.fixtures, [
    {path: '/utf8', status: 200, expectHeaders: {'content-type': 'text/html; charset=utf-8'}, expectBody: expected},
    {path: '/utf8', method: 'HEAD', status: 200, expectBody: ''},
  ]);
  // The fixtures pass against a project that serves those files.
  await writeFile(join(dist, 'urlcode.yaml'), `version: "1"\nroutes:\n  /utf8:\n    page:\n      file: utf8.html\n`);
  await mkdir(join(dist, 'tests'));
  await writeFile(join(dist, 'tests/requests.json'), JSON.stringify(result.fixtures));
  assert.deepEqual(await runProjectTests(dist), {total: 2, failed: 0});
});

test('a render that is not a complete HTML page fails the build and writes nothing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-prerender-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const cases: Array<[string, RegExp]> = [
    ['export default () => new Response("gone", {status: 404, headers: {"content-type": "text/html"}});', /rendered 404/],
    ['export default () => Response.json({ok: true});', /expected text\/html/],
    ['export default () => new Response("", {headers: {"content-type": "text/html"}});', /rendered 0 bytes; expected 1\.\./],
  ];
  for (const [index, [source, expected]] of cases.entries()) {
    const dist = join(directory, `out-${index}`);
    await assert.rejects(prerenderPages(await build(t, {'/page': 'x'}, source), dist), expected);
    // A failed render leaves no artifact behind at all.
    await assert.rejects(readdir(dist), {code: 'ENOENT'});
  }
  // Nothing is left running: a build in the same process still succeeds.
  assert.equal((await prerenderPages(recipe, join(directory, 'ok'))).count, 3);
});

test('budgets bound pages, per-page bytes and the whole render', async t => {
  const dist = await output(t);
  const three = {'/a': 'a', '/b': 'b', '/c': 'c'};
  await assert.rejects(prerenderPages(await build(t, three), dist, {maxPages: 2}), /page count 3 exceeds maxPages 2/);
  await assert.rejects(prerenderPages(await build(t, three), dist, {maxPageBytes: 4}), /expected 1\.\.4 \(maxPageBytes\)/);
  // Each page fits, but together they exceed the aggregate budget.
  await assert.rejects(prerenderPages(await build(t, three), dist, {maxTotalBytes: 20}), /total budget of 20 bytes/);
  for (const budget of [{maxPages: 0}, {maxPageBytes: -1}, {maxTotalBytes: 1.5}])
    await assert.rejects(prerenderPages(recipe, dist, budget), /must be a positive integer/);
  assert.equal((await prerenderPages(await build(t, three), dist, {maxPages: 3, maxTotalBytes: 1024})).count, 3);
});

test('the render origin is explicit and validated', async t => {
  const dist = await output(t);
  const source = await build(t, {'/where': 'x'}, html('`<p>${request.url}</p>`'));
  const rendered = await prerenderPages(source, dist, {origin: 'https://docs.example.invalid'});
  assert.equal(rendered.fixtures[0]?.expectBody, '<p>https://docs.example.invalid/where</p>');
  for (const origin of ['https://example.com/path', 'ftp://example.com', 'https://user:pw@example.com', 'not a url'])
    await assert.rejects(prerenderPages(source, dist, {origin}), /render origin/i);
});

test('unrenderable source routes fail the build unless explicitly ignored', async t => {
  const dist = await output(t);
  const {routes, files} = site({'/page': 'x'});
  const mixed = await project(t, {...routes, '/go': {redirect: {url: 'https://example.com/'}}}, files);
  await assert.rejects(prerenderPages(mixed, dist), /would not render: \/go \(redirect, active\)/);
  const partial = await prerenderPages(mixed, dist, {ignoreUnrenderable: true});
  assert.deepEqual(partial.pages.map(page => page.path), ['/page']);
  const nothing = await project(t, {'/go': {redirect: {url: 'https://example.com/'}}});
  await assert.rejects(prerenderPages(nothing, dist, {ignoreUnrenderable: true}), /no active GET function routes/);
});

test('output paths are refused when unsafe, overlapping, colliding or already present', async t => {
  const dist = await output(t);
  await assert.rejects(prerenderPages(recipe, recipe), /must not overlap/);
  await assert.rejects(prerenderPages(recipe, join(recipe, 'out')), /must not overlap/);
  // The source nested inside the output is an overlap in the other direction.
  await assert.rejects(prerenderPages(join(dist, 'src'), dist), /must not overlap/);
  await prerenderPages(recipe, dist);
  await assert.rejects(prerenderPages(recipe, dist), /already exists; remove it/);
  // An existing artifact survives the refusal untouched.
  assert.deepEqual((await readdir(dist)).sort(), ['about.html', 'guide.html', 'index.html']);
  // The default scheme cannot collide, so a collision needs a custom hook.
  const collide = await build(t, {'/a/b': 'one', '/c': 'two'});
  await assert.rejects(prerenderPages(collide, join(dist, '..', 'c1'), {fileName: () => 'same.html'}),
    /Routes \/a\/b and \/c both render same\.html/);
  // Case-only differences are one file on macOS and Windows.
  const cased = await build(t, {'/Readme': 'one', '/readme': 'two'});
  await assert.rejects(prerenderPages(cased, join(dist, '..', 'c2')), /both render readme\.html/i);
  const custom = {fileName: () => '../escape.html'};
  await assert.rejects(prerenderPages(recipe, join(dist, '..', 'c3'), custom), /Unsafe output filename/);
  for (const name of ['urlcode.yaml', 'page.txt', '.hidden.html', 'a/b.html', ''])
    await assert.rejects(prerenderPages(recipe, join(dist, '..', 'c4'), {fileName: () => name}), /Unsafe output filename/);
});

test('a nonliteral route is refused even when a custom fileName would accept it', async t => {
  const dist = await output(t);
  const parameterized = await project(t, {
    '/page/{name}': {parameters: [{name: 'name', in: 'path', required: true, schema: {type: 'string'}}],
      middleware: [{source: 'middleware/t.mjs'}], function: {source: 'functions/p.mjs', args: {title: 'x'}}},
  }, site({}).files);
  await assert.rejects(prerenderPages(parameterized, dist), /nonliteral route \/page\/\{name\}/);
  // A hook that ignores the path cannot smuggle one past the check: the route
  // path is validated before fileName is consulted.
  await assert.rejects(prerenderPages(parameterized, dist, {fileName: () => 'page.html'}), /nonliteral route/);
  assert.throws(() => assertLiteralRoutePath('/a/*'), /nonliteral route/);
  assert.deepEqual(assertLiteralRoutePath('/a/b'), ['a', 'b']);
});

test('an existing output directory is refused with a code a caller can branch on', async t => {
  const dist = await output(t);
  await prerenderPages(recipe, dist);
  await assert.rejects(prerenderPages(recipe, dist), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'EEXIST' && /already exists; remove it/.test(error.message));
});

test('a custom fileName hook is honoured when its output is safe', async t => {
  const dist = await output(t);
  // The docs site hashes the whole route; the helper still owns the safety check.
  const {createHash} = await import('node:crypto');
  const fileName = (path: string) => `page-${createHash('sha256').update(path).digest('hex')}.html`;
  const rendered = await prerenderPages(await build(t, {'/a/b': 'x', '/a-b': 'y'}), dist, {fileName});
  assert.deepEqual(rendered.pages.map(page => page.file), ['/a/b', '/a-b'].map(fileName));
  assert.deepEqual((await readdir(dist)).sort(), ['/a/b', '/a-b'].map(fileName).sort());
});

test('assertNativeProject proves a final site cannot execute guest code', async t => {
  const dist = await output(t);
  await prerender(recipe, dist);
  const inventory = await assertNativeProject(dist, {allow: ['page']});
  assert.equal(inventory.length, 3);
  // A real site also serves static files and downloads; that is the default.
  const full = await project(t, {
    '/page': {page: {file: 'public/a.html'}},
    '/assets/*': {static: {directory: 'public'}},
    '/dl': {download: {file: 'public/a.html'}},
  }, {'public/a.html': '<p>a</p>'});
  assert.equal((await assertNativeProject(full)).length, 3);
  await assert.rejects(assertNativeProject(full, {allow: ['page']}), /only native page routes/);
  const {routes, files} = site({'/page': 'x'});
  await assert.rejects(assertNativeProject(await project(t, routes, files)), /\/page \(function \+ middleware\)/);
  const wrapped = await project(t, {'/page': {middleware: [{source: 'middleware/t.mjs'}], page: {file: 'public/a.html'}}},
    {...files, 'public/a.html': '<p>a</p>'});
  await assert.rejects(assertNativeProject(wrapped), /\+ middleware/);
  await assert.rejects(assertNativeProject(await project(t, {})), /declares no routes/);
  await assert.rejects(assertNativeProject(dist, {allow: []}), /nonempty string array/);
});

// A build over a large generated site hits the snapshot budgets (#60). The
// message must name the module that crossed it and the counts, not just the
// bound, so the failure reads as "this site outgrew one pass".
test('crossing the function module budget names the module and the limits', async t => {
  const routes: Record<string, RouteConfig> = {}, files: ProjectFiles = {};
  for (let index = 0; index < 130; index++) {
    files[`functions/p${index}.mjs`] = html('`<p>page</p>`');
    routes[`/p${index}`] = {function: {source: `functions/p${index}.mjs`}};
  }
  const source = await project(t, routes, files);
  await assert.rejects(prerenderPages(source, await output(t)), (error: Error) => {
    assert.match(error.message, /Function module limit exceeded: \/functions\/p\d+\.mjs is module 129, over the limit of 128 modules per snapshot/);
    return true;
  });
});

test('crossing the total function source budget names the module and the byte counts', async t => {
  const routes: Record<string, RouteConfig> = {}, files: ProjectFiles = {};
  // Ten modules of ~512 KiB: under the per-module limit, over the 4 MiB total.
  const filler = '// ' + 'x'.repeat(512 * 1024);
  for (let index = 0; index < 10; index++) {
    files[`functions/p${index}.mjs`] = `${filler}\n${html('`<p>page</p>`')}`;
    routes[`/p${index}`] = {function: {source: `functions/p${index}.mjs`}};
  }
  const source = await project(t, routes, files);
  await assert.rejects(prerenderPages(source, await output(t)), (error: Error) => {
    assert.match(error.message, /Function source limit exceeded: \/functions\/p\d+\.mjs \(\d+ bytes\) brings the snapshot to \d+ bytes, over the total limit of 4194304 bytes/);
    return true;
  });
});
