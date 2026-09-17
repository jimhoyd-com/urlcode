import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {prerender, outputName} from '../examples/prerender/prerender.mjs';
import {runProjectTests} from '../src/project-tests.js';
import {createRuntime} from '../src/runtime.js';
import {project} from './helpers.js';

const recipe = fileURLToPath(new URL('../examples/prerender', import.meta.url));
const output = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-prerender-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return join(directory, 'dist');
};

test('the example project serves the same pages dynamically and prerendered', async t => {
  const dist = await output(t);
  const report = await prerender(recipe, dist);
  assert.equal(report.pages, 3);
  assert.ok(report.bytes > 0);
  // The dynamic source and the generated artifact both pass their own fixtures.
  assert.deepEqual(await runProjectTests(recipe), {total: 7, failed: 0});
  const generated = await runProjectTests(dist);
  assert.equal(generated.failed, 0);
  assert.equal(generated.total, 6);
  const html = await readFile(join(dist, 'public', 'about.html'), 'utf8');
  // The shared template was applied, and page data cannot inject markup.
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>About &amp; &quot;quoting&quot;<\/title>/);
  assert.ok(!html.includes('About & "quoting"'));
  assert.match(html, /No guest code runs to serve this page/);
});

test('the generated project is inert: native pages only, no guest execution', async t => {
  const dist = await output(t);
  await prerender(recipe, dist);
  const document = parse(await readFile(join(dist, 'urlcode.yaml'), 'utf8'));
  assert.equal(document.version, '1');
  assert.deepEqual(Object.keys(document.routes), ['/', '/guide', '/about']);
  for (const route of Object.values(document.routes)) {
    assert.deepEqual(Object.keys(route), ['page']);
    assert.match(route.page.file, /^public\/[a-z0-9-]+\.html$/);
  }
  const runtime = await createRuntime(dist, {log: () => {}});
  t.after(() => runtime.close());
  const inventory = runtime.testPlan().inventory;
  assert.equal(inventory.length, 3);
  assert.ok(inventory.every(route => route.handler === 'page' && route.middleware === 0));
});

test('route paths map to one safe flat filename or the build fails', () => {
  assert.equal(outputName('/'), 'index.html');
  assert.equal(outputName('/guide'), 'guide.html');
  assert.equal(outputName('/docs/getting-started'), 'docs-getting-started.html');
  for (const path of ['/{code}', '/assets/*', '/../escape', '/.hidden', '/Upper', '/a//b', '/page.html', '/a b'])
    assert.throws(() => outputName(path), /safe filename/, `accepted ${path}`);
});

test('a render that is not a complete HTML page fails the build and closes the runtime', async t => {
  const dist = await output(t);
  const broken = await project(t, {'/gone': {function: {source: 'functions/gone.mjs'}}},
    {'functions/gone.mjs': 'export default () => new Response("missing", {status: 404});'});
  await assert.rejects(prerender(broken, dist), /rendered 404; expected 200/);
  const wrongType = await project(t, {'/data': {function: {source: 'functions/data.mjs'}}},
    {'functions/data.mjs': 'export default () => Response.json({ok: true});'});
  await assert.rejects(prerender(wrongType, dist), /expected text\/html/);
  const empty = await project(t, {'/blank': {function: {source: 'functions/blank.mjs'}}},
    {'functions/blank.mjs': 'export default () => new Response("", {headers: {"content-type": "text/html"}});'});
  await assert.rejects(prerender(empty, dist), /empty body/);
  // Nothing is left running: a fourth build in the same process still works.
  assert.equal((await prerender(recipe, dist)).pages, 3);
});

test('prerender refuses unsafe outputs, colliding pages and projects with nothing to render', async t => {
  const dist = await output(t);
  await assert.rejects(prerender(recipe, recipe), /outside the source project/);
  await assert.rejects(prerender(recipe, join(recipe, 'dist')), /outside the source project/);
  const page = title => ({middleware: [{source: 'middleware/t.mjs'}], function: {source: 'functions/p.mjs', args: {title}}});
  const files = {
    'functions/p.mjs': 'export default (request, {args}) => new Response(`<p>${args.title}</p>`, {headers: {"content-type": "text/html"}});',
    'middleware/t.mjs': 'export default async (request, context, next) => next();',
  };
  const collision = await project(t, {'/a/b': page('one'), '/a-b': page('two')}, files);
  await assert.rejects(prerender(collision, dist), /both render a-b\.html/);
  const parameterized = await project(t, {'/page/{name}': {parameters: [{name: 'name', in: 'path', required: true, schema: {type: 'string'}}], ...page('x')}}, files);
  await assert.rejects(prerender(parameterized, dist), /Cannot derive a safe filename/);
  const nothing = await project(t, {'/go': {redirect: {url: 'https://example.com/'}}});
  await assert.rejects(prerender(nothing, dist), /No active function routes/);
  const file = join(dist, 'not-a-directory');
  await mkdir(dist, {recursive: true});
  await writeFile(file, 'x');
  await assert.rejects(prerender(recipe, file), /must be a directory/);
});
