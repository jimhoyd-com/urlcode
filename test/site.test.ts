import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { startServer } from '../packages/core/src/server.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { createFetchHandler } from '../packages/core/src/cloudflare.ts';
import { expandSite, generatedPaths } from '../packages/core/src/site.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { project, request, redirect } from './helpers.ts';
import type { ProjectRoutes } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { ServerOptions } from '../packages/core/src/server.ts';
import type { Artifact, Validators } from '../packages/core/src/cloudflare.ts';

const origin = 'https://links.example';
const html = '<!doctype html><title>x</title>';
const files = { 'public/index.html': html, 'public/other.html': html, 'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'llms.txt': '# Site\n', 'public/404.html': html };
const securityTxt = { contact: ['mailto:security@example.com', 'https://example.com/report'], expires: '2099-01-01T00:00:00Z',
  policy: ['https://example.com/policy'], acknowledgments: ['https://example.com/thanks'], preferredLanguages: ['en', 'fr'],
  canonical: ['https://links.example/.well-known/security.txt'], encryption: ['https://example.com/key.asc'] };

async function serve(t: TestContext, routes: ProjectRoutes, site: Record<string, unknown>, options: Partial<ServerOptions> = {}) {
  const events: Record<string, unknown>[] = [];
  const root = await project(t, routes, files, { site });
  const app = await startServer({ project: root, port: 0, log: e => { events.push(e); }, ...options });
  t.after(() => app.close());
  return { app, root, events };
}

test('every site key generates a native route with the expected body, type and cache policy', async t => {
  const { app, events } = await serve(t, { '/': { page: { file: 'public/index.html' } } },
    { robots: { disallow: ['/admin', '/private/'], allow: ['/admin/public'], sitemap: true, extra: ['# generated'] },
      sitemap: true, favicon: 'public/favicon.svg', securityTxt, llms: 'llms.txt', notFound: 'public/404.html' }, { origin });

  const robots = await request(app, '/robots.txt');
  assert.equal(robots.status, 200);
  assert.equal(robots.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(robots.body, 'User-agent: *\nDisallow: /admin\nDisallow: /private/\nAllow: /admin/public\n\nSitemap: https://links.example/sitemap.xml\n\n# generated\n');

  const sitemap = await request(app, '/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.headers['content-type'], 'application/xml; charset=utf-8');
  assert.match(sitemap.body, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">\n {2}<url><loc>https:\/\/links.example\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod><\/url>\n<\/urlset>\n$/);

  const favicon = await request(app, '/favicon.ico');
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers['content-type'], 'image/svg+xml');
  assert.equal(favicon.headers['cache-control'], 'public, max-age=3600');
  assert.equal(favicon.body, files['public/favicon.svg']);

  const security = await request(app, '/.well-known/security.txt');
  assert.equal(security.status, 200);
  assert.equal(security.headers['content-type'], 'text/plain; charset=utf-8');
  // RFC 9116 §2.5 order, one value per line, languages as one list.
  assert.equal(security.body, ['Acknowledgments: https://example.com/thanks', 'Canonical: https://links.example/.well-known/security.txt',
    'Contact: mailto:security@example.com', 'Contact: https://example.com/report', 'Encryption: https://example.com/key.asc',
    'Expires: 2099-01-01T00:00:00Z', 'Policy: https://example.com/policy', 'Preferred-Languages: en, fr'].join('\n') + '\n');

  const llms = await request(app, '/llms.txt');
  assert.equal(llms.status, 200);
  assert.equal(llms.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(llms.body, '# Site\n');

  // HEAD works like any native route.
  assert.equal((await request(app, '/robots.txt', { method: 'HEAD' })).body, '');
  assert.deepEqual(events.filter(e => e['event'] === 'site' && e['status'] === 'generated').map(e => e['path']).sort(), Object.values(generatedPaths).sort());
  assert.ok(events.some(e => e['event'] === 'site' && e['key'] === 'securityTxt' && e['severity'] === 'warning' && /more than a year/.test(String(e['message']))));
});

test('the inventory records provenance and the audit counts generated routes', async t => {
  const { app } = await serve(t, { '/': { respond: { text: 'home' } } }, { robots: { disallow: ['/x'] }, llms: 'llms.txt' });
  const plan = app.testPlan();
  assert.equal(plan.inventory.length, 3);
  assert.deepEqual(plan.inventory.filter(r => r.generated).map(r => [r.path, r.generated, r.handler]),
    [['/robots.txt', 'site.robots', 'respond'], ['/llms.txt', 'site.llms', 'page']]);
  assert.equal(plan.inventory.find(r => r.path === '/')?.generated, undefined);
  // Generated cases assert the exact body, so audit coverage needs no fixture.
  assert.ok(plan.cases.some(c => c.path === '/robots.txt' && c.expectBody === 'User-agent: *\nDisallow: /x\n'));
});

test('robots lists resolve through the bundled agent lists and skip non-token names', async t => {
  const { app, events } = await serve(t, { '/': { respond: { text: 'home' } } }, { robots: { disallow: ['ai-crawlers'], allow: ['monitoring'] } });
  const { body } = await request(app, '/robots.txt');
  const [deny = '', allow = '', star] = body.split('\n\n');
  assert.ok(deny.includes('User-agent: GPTBot\n') && deny.includes('User-agent: ClaudeBot\n') && deny.endsWith('\nDisallow: /'));
  assert.ok(allow.startsWith('User-agent: ') && allow.endsWith('\nAllow: /'));
  assert.equal(star, 'User-agent: *\nAllow: /\n');
  assert.ok((deny + '\n' + allow).split('\n').every(line => /^(?:User-agent: [A-Za-z0-9_.-]+|Disallow: \/|Allow: \/)$/.test(line)), 'only product tokens are listed');
  assert.ok(events.some(e => e['event'] === 'site' && e['key'] === 'robots' && e['severity'] === 'info' && typeof e['skipped'] === 'number' && e['skipped'] > 0));
});

test('validation failures name the site key', async t => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ robots: { disallow: ['nope'] } }, /site\.robots\.disallow entry "nope"/],
    [{ robots: { extra: ['a\nb'] } }, /site\.robots\.extra/],
    [{ sitemap: { changefreq: 'sometimes' } }, /site\/sitemap/],
    [{ sitemap: { exclude: ['drafts'] } }, /site\.sitemap\.exclude/],
    [{ favicon: 'public/index.html' }, /site\.favicon must be an \.ico, \.svg or \.png/],
    [{ favicon: 'public/missing.png' }, /missing/],
    [{ securityTxt: { contact: ['security@example.com'], expires: '2099-01-01T00:00:00Z' } }, /site\.securityTxt\.contact value "security@example.com"/],
    [{ securityTxt: { contact: ['mailto:a@example.com'], expires: '2020-01-01T00:00:00Z' } }, /site\.securityTxt\.expires is in the past/],
    [{ securityTxt: { contact: ['mailto:a@example.com'], expires: 'tomorrow' } }, /site\/securityTxt\/expires/],
    [{ securityTxt: { contact: ['mailto:a@example.com'], expires: '2099-01-01T00:00:00Z', policy: ['http://example.com/p'] } }, /site\/securityTxt\/policy/],
    [{ securityTxt: { contact: ['mailto:a@example.com'], expires: '2099-01-01T00:00:00Z', encryption: ['ftp://x'] } }, /site\.securityTxt\.encryption/],
    [{ securityTxt: { expires: '2099-01-01T00:00:00Z' } }, /site\/securityTxt/],
    [{ humans: 'humans.txt' }, /\/site/],
    [{ llms: 'missing.txt' }, /missing/],
  ];
  for (const [site, message] of cases) {
    const root = await project(t, { '/': { respond: { text: 'home' } } }, files, { site });
    await assert.rejects(createRuntime(root, { origin, log: () => {} }), message, JSON.stringify(site));
  }
});

test('site is accepted only in the entry file', async t => {
  const root = await project(t, {}, { ...files, 'routes/extra.yaml': stringify({ version: '1', site: { llms: 'llms.txt' }, routes: { '/a': { respond: { text: 'a' } } } }) }, { includes: ['routes/extra.yaml'] });
  await assert.rejects(loadDocument(root), /site may only be set in the entry urlcode\.yaml/);
});

test('a declared route at a generated path wins and is logged as shadowed', async t => {
  const { app, events } = await serve(t, { '/robots.txt': { respond: { text: 'mine' } }, '/.well-known/security.txt': { respond: { text: 'also mine' } } },
    { robots: { disallow: ['/x'] }, securityTxt: { contact: ['mailto:a@example.com'], expires: '2099-01-01T00:00:00Z' }, llms: 'llms.txt' });
  assert.equal((await request(app, '/robots.txt')).body, 'mine');
  assert.equal((await request(app, '/.well-known/security.txt')).body, 'also mine');
  assert.equal((await request(app, '/llms.txt')).status, 200);
  assert.deepEqual(events.filter(e => e['event'] === 'site' && e['status'] === 'shadowed').map(e => [e['key'], e['path']]),
    [['robots', '/robots.txt'], ['securityTxt', '/.well-known/security.txt']]);
  assert.equal(app.testPlan().inventory.find(r => r.path === '/robots.txt')?.generated, undefined);
});

test('a .well-known route key is an ordinary declared route', async t => {
  const root = await project(t, { '/.well-known/change-password': redirect('https://example.com/account') });
  const app = await startServer({ project: root, port: 0, log: () => {} });
  t.after(() => app.close());
  assert.equal((await request(app, '/.well-known/change-password')).status, 302);
  // Only the two dot segments stay refused.
  await assert.rejects(createRuntime(await project(t, { '/a/../b': redirect() }), { log: () => {} }), /Dot path segments/);
});

test('the sitemap lists HTML routes, honours exclusions and noindex, and dates asset routes', async t => {
  const root = await project(t, {
    '/': { page: { file: 'public/index.html' } },
    '/other': { page: { file: 'public/other.html' } },
    '/typed': { page: { file: 'public/page.txt', contentType: 'text/html' } },
    '/fragment': { respond: { text: '<p>x</p>' }, response: { headers: { 'Content-Type': 'text/html; charset=utf-8' } } },
    '/plain': { respond: { text: 'x' } },
    '/hidden': { page: { file: 'public/index.html' }, response: { headers: { 'X-Robots-Tag': 'noindex, nofollow' } } },
    '/off': { page: { file: 'public/index.html' }, enabled: false },
    '/gone': { page: { file: 'public/index.html' }, expires: '2020-01-01T00:00:00Z' },
    '/go': redirect(),
    '/post': { methods: ['POST'], respond: { text: '<p>x</p>' }, response: { headers: { 'Content-Type': 'text/html' } } },
    '/p/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], page: { file: 'public/index.html' } },
    '/drafts/one': { page: { file: 'public/index.html' } },
    '/drafts/': { page: { file: 'public/index.html' } },
    '/skip': { page: { file: 'public/index.html' } },
    '/docs/*': { static: { directory: 'public/docs', index: 'index.html' } },
    '/llms.txt': { page: { file: 'llms.txt' } },
  }, { ...files, 'public/page.txt': html, 'public/docs/index.html': html, 'public/docs/guide.html': html, 'public/docs/style.css': 'a{}',
    'public/docs/.secret.html': html, 'public/docs/sub dir/page.html': html },
  { site: { sitemap: { exclude: ['/drafts/*', '/skip'], changefreq: 'daily', priority: 0.8 } } });
  const stamp = new Date('2024-05-06T12:00:00Z');
  await utimes(join(root, 'public/other.html'), stamp, stamp);
  const app = await startServer({ project: root, port: 0, origin, log: () => {} });
  t.after(() => app.close());
  const { body } = await request(app, '/sitemap.xml');
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, ['https://links.example/', 'https://links.example/docs/', 'https://links.example/docs/guide.html',
    'https://links.example/docs/sub%20dir/page.html', 'https://links.example/fragment', 'https://links.example/other', 'https://links.example/typed']);
  assert.match(body, /<loc>https:\/\/links.example\/other<\/loc><lastmod>2024-05-06<\/lastmod><changefreq>daily<\/changefreq><priority>0.8<\/priority>/);
  assert.match(body, /<loc>https:\/\/links.example\/fragment<\/loc><changefreq>daily<\/changefreq>/, 'no lastmod without a file');
});

test('a sitemap refuses activation without a public origin and past the size limits', async t => {
  const root = await project(t, { '/': { page: { file: 'public/index.html' } } }, files, { site: { sitemap: true } });
  await assert.rejects(createRuntime(root, { log: () => {} }), /site\.sitemap: a sitemap needs absolute URLs; start with --origin/);
  await assert.rejects(createRuntime(root, { origin: 'https://links.example/app', log: () => {} }), /origin must be an HTTP\(S\) origin/);
  const routes = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`/pages/${'x'.repeat(300)}/${i}`, { page: { file: 'public/index.html' } }]));
  const big = await project(t, routes, files, { site: { sitemap: true } });
  await assert.rejects(createRuntime(big, { origin, log: () => {} }), /site\.sitemap: the sitemap exceeds the 1 MiB declared-response limit; generate the file at build time/);
  const many = Object.fromEntries(Array.from({ length: 50001 }, (_, i) => [`/${i}`, { page: { file: 'public/index.html' } }]));
  await assert.rejects(expandSite({ version: '1', site: { sitemap: true }, routes: many }, root, { origin }), /50001 URLs exceed the 50000/);
});

test('robots omits the Sitemap line without an origin and reports it', async t => {
  const { app, events } = await serve(t, { '/': { respond: { text: 'home' } } }, { robots: { disallow: ['/x'], sitemap: true } });
  assert.equal((await request(app, '/robots.txt')).body, 'User-agent: *\nDisallow: /x\n');
  assert.ok(events.some(e => e['event'] === 'site' && e['key'] === 'robots' && e['severity'] === 'info' && /Sitemap line is omitted/.test(String(e['message']))));
});

test('the Cloudflare artifact serves generated robots and security.txt exactly as the server does', async t => {
  const site = { robots: { disallow: ['ai-crawlers', '/admin'], sitemap: true }, securityTxt, sitemap: true };
  const root = await project(t, { '/': { respond: { text: html }, response: { headers: { 'Content-Type': 'text/html' } } } }, files, { site });
  const hosted = await startServer({ project: root, port: 0, origin, log: () => {} });
  t.after(() => hosted.close());
  const out = await mkdtemp(join(tmpdir(), 'urlcode-site-cf-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const report = await buildCloudflare(root, { out, origin });
  assert.equal(report.routes, 4);
  const artifact: Artifact = (await import(pathToFileURL(join(out, 'artifact.js')).href)).default;
  const validators: Validators = await import(pathToFileURL(join(out, 'validators.js')).href);
  const fetch = createFetchHandler(artifact, validators);
  for (const path of ['/robots.txt', '/.well-known/security.txt', '/sitemap.xml']) {
    const a = await request(hosted, path);
    const b = await fetch(new Request(`${origin}${path}`));
    assert.equal(b.status, a.status, path);
    assert.equal(await b.text(), a.body, path);
    assert.equal(b.headers.get('content-type'), a.headers['content-type'], path);
  }
  assert.match((await fetch(new Request(`${origin}/robots.txt`)).then(r => r.text())), /Sitemap: https:\/\/links.example\/sitemap.xml/);
  // The page-backed keys are refused like any page route, with the path named.
  await assert.rejects(buildCloudflare(await project(t, { '/': { respond: { text: 'x' } } }, files, { site: { favicon: 'public/favicon.svg' } }), { out: await mkdtemp(join(tmpdir(), 'urlcode-site-cf-')) }),
    /\/favicon\.ico[\s\S]*capability: page[\s\S]*static-asset binding/);
});

test('generated routes stay out of the operator-policy hash and reload with the project', async t => {
  const root = await project(t, { '/': { respond: { text: 'home' } } }, files, { site: { robots: { disallow: ['/x'], sitemap: true } } });
  const { prepareFunctionSnapshot } = await import('../packages/core/src/policy.ts');
  const { applySite } = await import('../packages/core/src/site.ts');
  const plain = await prepareFunctionSnapshot(await loadDocument(root));
  const loaded = await loadDocument(root);
  await applySite(loaded, { origin });
  assert.equal((await prepareFunctionSnapshot(loaded)).projectSha256, plain.projectSha256);
  // Versions differ between a project with and without site, so a reload notices.
  await mkdir(join(root, 'x'), { recursive: true });
  await writeFile(join(root, 'urlcode.yaml'), stringify({ version: '1', routes: { '/': { respond: { text: 'home' } } } }));
  assert.notEqual((await loadDocument(root)).version, loaded.version);
});

test('site.notFound answers an unmatched GET/HEAD with the page and status 404, and refuses non-HTML files', async t => {
  const page = '<!doctype html><title>Gone</title><h1>Lost</h1>';
  const root = await project(t, { '/': { respond: { text: 'home' } } }, { ...files, 'public/404.html': page }, { site: { notFound: 'public/404.html' } });
  const app = await startServer({ project: root, port: 0, log: () => {} });
  t.after(() => app.close());
  const get = await request(app, '/nope/deeper?q=1');
  assert.equal(get.status, 404);
  assert.match(get.headers['content-type'] ?? '', /^text\/html/);
  assert.equal(get.body, page);
  assert.equal(get.headers['x-content-type-options'], 'nosniff');
  const head = await request(app, '/nope', { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(head.body, '');
  const post = await request(app, '/nope', { method: 'POST' });
  assert.equal(post.status, 404);
  assert.equal(post.body, 'Not found\n');
  assert.equal((await request(app, '/')).body, 'home');
  const direct = await request(app, '/404.html');
  assert.equal(direct.status, 200);
  const loaded = await loadDocument(root);
  const generated = await expandSite(loaded.document, root, { routes: loaded.routes });
  assert.equal(generated[generatedPaths.notFound]?.generated, 'site.notFound');
  await assert.rejects(createRuntime(await project(t, { '/': { respond: { text: 'x' } } }, { ...files, 'public/404.txt': 'x' }, { site: { notFound: 'public/404.txt' } })), /site\/notFound/);
});

test('site.notFound builds as 404.html for static hosting', async t => {
  const { buildStatic } = await import('../packages/core/src/build-static.ts');
  const root = await project(t, { '/': { page: { file: 'public/index.html' } } }, { ...files, 'public/404.html': '<h1>Lost</h1>' }, { site: { notFound: 'public/404.html' } });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-site-404-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildStatic(root, { out });
  assert.equal(await readFile(join(out, 'objects', '404.html'), 'utf8'), '<h1>Lost</h1>');
});

test('site.notFound is carried inline in the Cloudflare Worker: 404 for GET/HEAD, plain text for other methods', async t => {
  const page = '<!doctype html><h1>Lost \u00e9 "q" </script>${x}</h1>\n';
  const root = await project(t, { '/': { respond: { text: 'home' } } }, { ...files, 'public/404.html': page }, { site: { notFound: 'public/404.html' }, policies: { security: {} } });
  const out = await mkdtemp(join(tmpdir(), 'urlcode-site-cf-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildCloudflare(root, { out });
  const artifact = ((await import(pathToFileURL(join(out, 'artifact.js')).href)) as { default: Artifact }).default;
  assert.equal(artifact.notFound, true);
  const worker = createFetchHandler(artifact, {});
  const get = await worker(new Request('https://x.example/nope?q=1'));
  assert.equal(get.status, 404);
  assert.equal(get.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(get.headers.get('content-security-policy'));
  assert.equal(await get.text(), page);
  const head = await worker(new Request('https://x.example/nope', { method: 'HEAD' }));
  assert.equal(head.status, 404);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(page)));
  assert.equal(await head.text(), '');
  const post = await worker(new Request('https://x.example/nope', { method: 'POST' }));
  assert.equal(post.status, 404);
  assert.match(post.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await post.text(), 'Not found\n');
  const direct = await worker(new Request('https://x.example/404.html'));
  assert.equal(direct.status, 200);
  assert.equal(await direct.text(), page);
  assert.equal((await worker(new Request('https://x.example/'))).status, 200);
});

test('the Worker inlines site.notFound only within 64 KiB of valid UTF-8, and other pages stay refused', async t => {
  const out = () => mkdtemp(join(tmpdir(), 'urlcode-site-cf-'));
  const big = await project(t, { '/': { respond: { text: 'x' } } }, { ...files, 'public/404.html': 'a'.repeat(65537) }, { site: { notFound: 'public/404.html' } });
  await assert.rejects(buildCloudflare(big, { out: await out() }), /site\.notFound exceeds 65536 bytes/);
  const edge = await project(t, { '/': { respond: { text: 'x' } } }, { ...files, 'public/404.html': 'a'.repeat(65536) }, { site: { notFound: 'public/404.html' } });
  await buildCloudflare(edge, { out: await out() });
  const bad = await project(t, { '/': { respond: { text: 'x' } } }, { ...files, 'public/404.html': Buffer.from([0x3c, 0xff, 0xfe]) as unknown as string }, { site: { notFound: 'public/404.html' } });
  await assert.rejects(buildCloudflare(bad, { out: await out() }), /valid UTF-8/);
  const page = await project(t, { '/': { page: { file: 'public/index.html' } } }, { ...files, 'public/404.html': '<h1>Lost</h1>' }, { site: { notFound: 'public/404.html' } });
  await assert.rejects(buildCloudflare(page, { out: await out() }), /capability: page/);
  const shadowed = await project(t, { '/': { respond: { text: 'x' } }, '/404.html': { respond: { text: 'mine' } } }, { ...files, 'public/404.html': '<h1>Lost</h1>' }, { site: { notFound: 'public/404.html' } });
  const dir = await out();
  await buildCloudflare(shadowed, { out: dir });
  assert.equal(((await import(pathToFileURL(join(dir, 'artifact.js')).href)) as { default: Artifact }).default.notFound, undefined);
});
