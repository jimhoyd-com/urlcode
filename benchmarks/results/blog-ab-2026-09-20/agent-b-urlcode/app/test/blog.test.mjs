import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '@jimhoyd/urlcode';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
let dir, server, base;
const boot = async () => { server = await startServer({project, port: 0, host: '127.0.0.1'}); base = `http://127.0.0.1:${server.address.port}`; };
const get = (path, init) => fetch(base + path, {redirect: 'manual', ...init});
const post = (path, fields = {}) => fetch(base + path, {method: 'POST', redirect: 'manual', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(fields)});
const create = async (fields = {title: 'Hello World', content: 'Body text.\n\nSecond paragraph.'}) => {
  const res = await post('/admin/posts', fields); assert.equal(res.status, 303);
  const page = await (await get('/admin')).text();
  return [...page.matchAll(/\/admin\/posts\/([0-9a-f-]{36})\/publish|\/admin\/posts\/([0-9a-f-]{36})\/unpublish/g)].pop().slice(1).find(Boolean);
};

before(async () => { dir = await mkdtemp(join(tmpdir(), 'blog-')); process.env.BLOG_DATA_DIR = dir; await boot(); });
after(async () => { await server.close(); await rm(dir, {recursive: true, force: true}); });
// Each test starts from an empty blog (delete anything left over).
const reset = async () => { for (const m of (await (await get('/admin')).text()).matchAll(/\/admin\/posts\/([0-9a-f-]{36})\/delete/g)) await post(`/admin/posts/${m[1]}/delete`); };

test('application starts', () => assert.ok(server.address.port > 0));
test('empty blog works (public and admin)', async () => {
  await reset();
  for (const path of ['/', '/admin']) { const res = await get(path); assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/html/); }
  assert.match(await (await get('/')).text(), /No posts have been published yet/);
});
test('create, edit, publish, unpublish, delete lifecycle', async () => {
  await reset();
  const id = await create();
  assert.match(await (await get('/admin')).text(), /Hello World/);
  assert.match(await (await get(`/admin/posts/${id}`)).text(), /value="Hello World"/);
  // edit
  assert.equal((await post(`/admin/posts/${id}`, {title: 'Renamed', slug: 'renamed', excerpt: 'Short', content: 'New body'})).status, 303);
  assert.match(await (await get(`/admin/posts/${id}`)).text(), /value="renamed"/);
  // draft is not public
  assert.equal((await get('/posts/renamed')).status, 404);
  assert.doesNotMatch(await (await get('/')).text(), /Renamed/);
  // publish
  assert.equal((await post(`/admin/posts/${id}/publish`)).status, 303);
  const pub = await get('/posts/renamed'); assert.equal(pub.status, 200);
  const text = await pub.text(); assert.match(text, /Renamed/); assert.match(text, /New body/); assert.match(text, /\d{4}-\d{2}-\d{2}/);
  const home = await (await get('/')).text(); assert.match(home, /Renamed/); assert.match(home, /Short/); assert.match(home, /href="\/posts\/renamed"/);
  // unpublish
  assert.equal((await post(`/admin/posts/${id}/unpublish`)).status, 303);
  assert.equal((await get('/posts/renamed')).status, 404);
  assert.doesNotMatch(await (await get('/')).text(), /Renamed/);
  // delete
  assert.equal((await post(`/admin/posts/${id}/delete`)).status, 303);
  assert.doesNotMatch(await (await get('/admin')).text(), /Renamed/);
  assert.equal((await post(`/admin/posts/${id}/delete`)).status, 404);
});
test('index lists newest published first', async () => {
  await reset();
  const a = await create({title: 'Older', content: 'a'}); const b = await create({title: 'Newer', content: 'b'});
  await post(`/admin/posts/${a}/publish`); await new Promise(r => setTimeout(r, 5)); await post(`/admin/posts/${b}/publish`);
  const home = await (await get('/')).text(); assert.ok(home.indexOf('Newer') < home.indexOf('Older'));
});
test('missing post and unknown ids return 404', async () => {
  const res = await get('/posts/does-not-exist'); assert.equal(res.status, 404); assert.match(await res.text(), /Not found/);
  assert.equal((await get('/admin/posts/nope')).status, 404);
  assert.equal((await post('/admin/posts/nope', {title: 't', content: 'c'})).status, 404);
  assert.equal((await post('/admin/posts/nope/publish')).status, 404);
});
test('invalid input is rejected', async () => {
  await reset();
  let res = await post('/admin/posts', {title: '', content: ''}); assert.equal(res.status, 422);
  const html = await res.text(); assert.match(html, /Title is required/); assert.match(html, /Content is required/);
  res = await post('/admin/posts', {title: 'x', content: 'y', slug: 'Bad Slug!'}); assert.equal(res.status, 422);
  assert.match(await res.text(), /Slug may use only/);
  await create({title: 'Dup', content: 'c', slug: 'dup'});
  res = await post('/admin/posts', {title: 'Dup2', content: 'c', slug: 'dup'}); assert.equal(res.status, 422);
  assert.match(await res.text(), /already in use/);
  assert.equal((await post('/admin/posts', {title: 'x'.repeat(201), content: 'c'})).status, 422);
  // runtime-level checks declared in urlcode.yaml
  assert.equal((await get('/admin/posts')).status, 405);
  assert.equal((await fetch(base + '/admin/posts', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 415);
  assert.equal((await fetch(base + '/admin/posts', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'title=' + 'x'.repeat(300000)})).status, 413);
});
test('slug is generated from title and content is HTML-escaped', async () => {
  await reset();
  const id = await create({title: 'A <b>Title</b> & More', content: '<script>alert(1)</script>'});
  await post(`/admin/posts/${id}/publish`);
  const res = await get('/posts/a-b-title-b-more'); assert.equal(res.status, 200);
  const html = await res.text(); assert.doesNotMatch(html, /<script>alert/); assert.match(html, /&lt;script&gt;/);
});
test('data survives a server restart', async () => {
  await reset();
  const id = await create({title: 'Persistent', content: 'still here'});
  await post(`/admin/posts/${id}/publish`);
  await server.close(); await boot();
  const res = await get('/posts/persistent'); assert.equal(res.status, 200); assert.match(await res.text(), /still here/);
  assert.match(await (await get('/')).text(), /Persistent/);
});
