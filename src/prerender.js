import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, relative, isAbsolute, join, dirname, sep} from 'node:path';
import {createRuntime} from './runtime.js';
import {ConfigError, assert} from './errors.js';

// Operator-side build tooling for rendering a project's function and middleware
// routes once, ahead of serving, into HTML files that native page routes can
// publish with no guest execution on the request path.
//
// This is trusted build code, not runtime code: it runs in Node, it is never
// reachable from route YAML, and it gives the sandbox nothing. It owns the
// orchestration that is easy to get wrong — runtime lifecycle, response
// validation, budgets, byte fidelity and output-path safety — and deliberately
// owns nothing site-specific. Callers assemble their own project or generated
// include from the metadata it returns. See docs/PRERENDER.md.

// Names a static tree refuses to publish, rejected here so a bad route path
// fails the build instead of the deployment.
const PROTECTED = new Set(['urlcode.yaml', 'urlcode.yml', 'package.json', 'package-lock.json']);
const SEGMENT = /^[A-Za-z0-9._-]+$/;
// A published page name: no path separator, and no leading dot, which a static
// tree skips as a hidden entry.
const FILE = /^[A-Za-z0-9][A-Za-z0-9._~-]*\.html$/;
const overlaps = (first, second) => {
  const rel = relative(first, second);
  return rel === '' || !(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep));
};

// One route path to one flat filename, deterministically. `~` cannot occur in a
// route segment, so it separates segments unambiguously: `/a/b` and `/a-b` are
// distinct names rather than a silent collision. The root becomes `index`, and a
// literal `/index` route takes the otherwise unreachable `index~`, so the
// mapping stays injective for every accepted path. A flat name contains no path
// separator and no leading dot, so no output can escape its directory.
// A path that can become a file at all: absolute, literal, no parameter,
// wildcard, dot segment or empty segment. Checked for every rendered route
// whatever `fileName` does with it, so a custom hook cannot accept a route the
// default scheme would refuse.
export function assertLiteralRoutePath(path) {
  assert(typeof path === 'string' && path.startsWith('/'), 'Route path must be absolute');
  const segments = path === '/' ? [] : path.slice(1).split('/');
  assert(segments.every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..'),
    `Cannot derive a filename from nonliteral route ${path}; prerender literal paths only`);
  return segments;
}

export function pageFileName(path) {
  const segments = assertLiteralRoutePath(path);
  const name = segments.length === 1 && segments[0] === 'index' ? 'index~'
    : segments.length ? segments.join('~') : 'index';
  return `${name}.html`;
}

// Prove a project cannot execute guest code to answer a request: every route is
// one of the allowed native handlers and none carries middleware. Callers run it
// on a final assembled site, which normally also serves static files and
// downloads, not only on a page-only artifact.
export async function assertNativeProject(project, {allow = ['page', 'static', 'download'], log = () => {}} = {}) {
  assert(Array.isArray(allow) && allow.length && allow.every(handler => typeof handler === 'string'), 'Allowed handlers must be a nonempty string array');
  const runtime = await createRuntime(project, {log: () => {}});
  try {
    const inventory = runtime.testPlan().inventory;
    assert(inventory.length, 'Project declares no routes');
    const executable = inventory.filter(route => !allow.includes(route.handler) || route.middleware);
    assert(!executable.length,
      `Project must contain only native ${allow.join('/')} routes without middleware: ${executable.map(route => `${route.path} (${route.handler}${route.middleware ? ' + middleware' : ''})`).join(', ')}`);
    log({event: 'native-project', routes: inventory.length, handlers: allow});
    return inventory;
  } finally { await runtime.close(); }
}

export async function prerenderPages(project, output, {
  origin = 'http://localhost', fileName = pageFileName, ignoreUnrenderable = false,
  maxPages = 500, maxPageBytes = 512 * 1024, maxTotalBytes = 32 * 1024 * 1024, log = () => {},
} = {}) {
  for (const [value, name] of [[maxPages, 'maxPages'], [maxPageBytes, 'maxPageBytes'], [maxTotalBytes, 'maxTotalBytes']])
    assert(Number.isSafeInteger(value) && value > 0, `Build budget ${name} must be a positive integer`);
  assert(typeof fileName === 'function', 'fileName must be a function');
  assert(typeof ignoreUnrenderable === 'boolean', 'ignoreUnrenderable must be a boolean');
  let parsed;
  try { parsed = new URL(origin); } catch { assert(false, 'Invalid render origin'); }
  assert(['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin, 'Render origin must be HTTP(S) without path or credentials');
  const source = resolve(project), directory = resolve(output);
  // Rendering into the reviewed source, or reading a source nested in the
  // output, lets a build consume or overwrite what it just produced.
  assert(!overlaps(source, directory) && !overlaps(directory, source), 'Source and output directories must not overlap');

  const pages = [];
  let bytes = 0;
  const runtime = await createRuntime(source, {log: () => {}});
  try {
    const inventory = runtime.testPlan().inventory;
    const renderable = route => route.handler === 'function' && route.state === 'active' && route.methods.includes('GET');
    const targets = inventory.filter(renderable);
    // Silently skipping a route publishes an incomplete site that looks whole.
    if (!ignoreUnrenderable) {
      const skipped = inventory.filter(route => !renderable(route));
      assert(!skipped.length,
        `Source project has routes this build would not render: ${skipped.map(route => `${route.path} (${route.handler}, ${route.state})`).join(', ')}. Pass ignoreUnrenderable to allow it`);
    }
    assert(targets.length, 'Source project has no active GET function routes to prerender');
    assert(targets.length <= maxPages, `Source project page count ${targets.length} exceeds maxPages ${maxPages}`);
    // Case-insensitive: on macOS and Windows two names differing only in case
    // are one file, so the second render would silently replace the first.
    const taken = new Map();
    for (const route of targets) {
      assertLiteralRoutePath(route.path);
      const file = fileName(route.path);
      assert(typeof file === 'string' && FILE.test(file) && !PROTECTED.has(file), `Unsafe output filename ${file} for route ${route.path}`);
      const key = file.toLowerCase();
      assert(!taken.has(key), `Routes ${taken.get(key)} and ${route.path} both render ${file}`);
      taken.set(key, route.path);
      const result = await runtime.handle({target: route.path, method: 'GET', origin});
      assert(result.status === 200, `${route.path} rendered ${result.status}; expected 200`);
      const type = result.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
      assert(/^text\/html\s*(?:;|$)/i.test(type), `${route.path} rendered ${type || 'no content type'}; expected text/html`);
      // The response body is bytes. Keeping it as a Buffer is what preserves a
      // multi-byte character exactly, through the file and its fixture alike.
      const body = Buffer.from(result.body);
      assert(body.length > 0 && body.length <= maxPageBytes,
        `${route.path} rendered ${body.length} bytes; expected 1..${maxPageBytes} (maxPageBytes)`);
      bytes += body.length;
      assert(bytes <= maxTotalBytes, `Rendered pages exceed the total budget of ${maxTotalBytes} bytes (maxTotalBytes)`);
      pages.push({path: route.path, file, bytes: body.length, body});
      log({event: 'prerendered', path: route.path, file, bytes: body.length});
    }
  } finally {
    // The runtime owns worker threads. Close it whether or not the render
    // succeeded, so a failing build exits instead of hanging.
    await runtime.close();
  }

  // Nothing is written until every page has rendered, and the directory itself
  // must be new: a failed or partial build never damages an existing artifact.
  // Parents are created; only the leaf carries that guarantee.
  await mkdir(dirname(directory), {recursive: true});
  try { await mkdir(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Keep the code so a caller can branch on it, with a message that says why.
    throw Object.assign(new ConfigError(`Output directory ${directory} already exists; remove it before prerendering`), {code: 'EEXIST'});
  }
  for (const page of pages) await writeFile(join(directory, page.file), page.body);
  return {
    count: pages.length, bytes, directory,
    pages: pages.map(({path, file, bytes: size}) => ({path, file, bytes: size})),
    // Byte-for-byte GET plus empty HEAD, ready to concatenate with a caller's
    // own fixtures. `.html` is served as text/html; charset=utf-8.
    fixtures: pages.flatMap(page => [
      {path: page.path, status: 200, expectHeaders: {'content-type': 'text/html; charset=utf-8'}, expectBody: page.body.toString('utf8')},
      {path: page.path, method: 'HEAD', status: 200, expectBody: ''},
    ]),
  };
}
