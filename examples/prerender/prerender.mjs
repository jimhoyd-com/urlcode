#!/usr/bin/env node
// Prerender recipe: render a project's function/middleware routes once, at build
// time, into a native page project that serves the same bytes with no guest
// execution on the request path.
//
// This is operator build tooling, not guest code: it runs in Node, reads and
// writes only the directories named on the command line, and never gives the
// sandbox filesystem access. In your own project, import from the package:
//
//   import {createRuntime} from 'urlcode';
//
import {mkdir, writeFile, rm, stat} from 'node:fs/promises';
import {join, resolve, relative, isAbsolute, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stringify} from 'yaml';
import {createRuntime} from '../../src/index.js';

// Build budgets. A prerender that exceeds them is a mistake to surface, not a
// larger artifact to write: the runtime's own asset limits are 16 MiB per file
// and 64 MiB per project, and a page that approaches them is not a page.
const MAX_PAGES = 500;
const MAX_PAGE_BYTES = 512 * 1024;
// Names a static tree refuses to publish. The runtime enforces these when the
// generated project activates; the recipe refuses to create them in the first
// place, so a bad route path fails the build instead of the deployment.
const PROTECTED = new Set(['urlcode.yaml', 'urlcode.yml', 'package.json', 'package-lock.json']);

const check = (condition, message) => { if (!condition) throw new Error(message); };

// A route path becomes exactly one flat filename. Parameters and wildcards are
// rejected rather than guessed at, and the derived name cannot contain a path
// separator, a dot segment or a leading dot, so no output can escape the pages
// directory or shadow a protected name.
export function outputName(path) {
  const segment = '[a-z0-9]+(?:-[a-z0-9]+)*';
  check(new RegExp(`^/(?:${segment}(?:/${segment})*)?$`).test(path),
    `Cannot derive a safe filename from route ${path}; prerender only lowercase literal paths`);
  const file = `${path === '/' ? 'index' : path.slice(1).replaceAll('/', '-')}.html`;
  check(/^[a-z0-9][a-z0-9-]*\.html$/.test(file) && !PROTECTED.has(file), `Unsafe output filename ${file}`);
  return file;
}

export async function prerender(project, output, {log = () => {}} = {}) {
  const source = resolve(project), out = resolve(output);
  // The artifact is a separate deployable tree. Writing inside the reviewed
  // source would let a build overwrite the code it just rendered.
  const inside = target => { const rel = relative(target, out); return rel === '' || !(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)); };
  check(!inside(source), 'Output directory must be outside the source project');
  try { check((await stat(out)).isDirectory(), 'Output path must be a directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const pages = [];
  const runtime = await createRuntime(source, {log: () => {}});
  try {
    const targets = runtime.testPlan().inventory
      .filter(route => route.handler === 'function' && route.state === 'active' && route.methods.includes('GET'));
    check(targets.length, 'No active function routes to prerender');
    check(targets.length <= MAX_PAGES, `Refusing to prerender more than ${MAX_PAGES} pages`);
    await mkdir(join(out, 'public'), {recursive: true});
    const taken = new Set();
    for (const route of targets) {
      const file = outputName(route.path);
      check(!taken.has(file), `Routes ${route.path} and an earlier route both render ${file}`);
      taken.add(file);
      const result = await runtime.handle({target: route.path, method: 'GET'});
      // Fail the build on anything but a complete HTML page. A 404, a 500 or a
      // truncated render must never be written out as a published file.
      check(result.status === 200, `${route.path} rendered ${result.status}; expected 200`);
      const type = result.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
      check(/^text\/html\b/.test(type), `${route.path} rendered ${type || 'no content type'}; expected text/html`);
      const body = Buffer.from(result.body);
      check(body.length > 0, `${route.path} rendered an empty body`);
      check(body.length <= MAX_PAGE_BYTES, `${route.path} rendered ${body.length} bytes; limit is ${MAX_PAGE_BYTES}`);
      await writeFile(join(out, 'public', file), body);
      pages.push({path: route.path, file, bytes: body.length, html: body.toString('utf8')});
      log({event: 'prerendered', path: route.path, file, bytes: body.length});
    }
  } finally {
    // The source runtime owns worker threads; close it whether or not the
    // render succeeded, so a failing build still exits.
    await runtime.close();
  }

  await writeFile(join(out, 'urlcode.yaml'), stringify({
    version: '1',
    routes: Object.fromEntries(pages.map(page => [page.path, {page: {file: `public/${page.file}`, cacheControl: 'no-cache'}}])),
  }));
  // Fixtures that prove each generated page is served, byte for byte.
  await mkdir(join(out, 'tests'), {recursive: true});
  await writeFile(join(out, 'tests/requests.json'), JSON.stringify(pages.flatMap(page => [
    {path: page.path, status: 200, expectHeaders: {'content-type': 'text/html; charset=utf-8'}, expectBody: page.html},
    {path: page.path, method: 'HEAD', status: 200, expectBody: ''},
  ]), null, 2) + '\n');

  // Activate what was just written and prove the artifact is inert: only native
  // page routes, no function, link or middleware anywhere. A recipe that ever
  // emitted guest code would fail here instead of shipping.
  const generated = await createRuntime(out, {log: () => {}});
  try {
    const executable = generated.testPlan().inventory.filter(route => route.handler !== 'page' || route.middleware);
    check(!executable.length, `Generated project must contain only native page routes: ${JSON.stringify(executable)}`);
  } finally { await generated.close(); }

  return {pages: pages.length, bytes: pages.reduce((total, page) => total + page.bytes, 0), output: out};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [project = fileURLToPath(new URL('.', import.meta.url)), output = 'dist'] = process.argv.slice(2);
  const print = value => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    if (process.argv.includes('--clean')) await rm(resolve(output), {recursive: true, force: true});
    print({event: 'prerendered-project', ...await prerender(project, output, {log: print})});
  } catch (error) {
    process.stderr.write(JSON.stringify({event: 'error', message: error.message}) + '\n');
    process.exitCode = 1;
  }
}
