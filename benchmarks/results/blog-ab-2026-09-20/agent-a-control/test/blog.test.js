const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../src/app');

async function start(dbFile) {
  const app = createApp({ dbFile });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (p, opts = {}) => {
    const { form, ...rest } = opts;
    if (form) { rest.method = 'POST'; rest.headers = { 'content-type': 'application/x-www-form-urlencoded' }; rest.body = new URLSearchParams(form).toString(); }
    return fetch(base + p, { redirect: 'manual', ...rest });
  };
  const stop = () => new Promise((r) => server.close(() => { app.close(); r(); }));
  return { req, stop };
}
const memory = () => start(':memory:');
const create = (t, form) => t.req('/admin/posts', { form });
const mk = async (t, title = 'Hello World', content = 'Body text here.', extra = {}) => {
  const r = await create(t, { title, content, ...extra });
  assert.equal(r.status, 303);
};
const idOf = async (t, title) => {
  const html = await (await t.req('/admin')).text();
  const m = html.match(new RegExp(`${title}[\\s\\S]*?/admin/posts/(\\d+)/edit`));
  return m && m[1];
};

test('application starts', async () => {
  const t = await memory();
  assert.equal((await t.req('/')).status, 200);
  await t.stop();
});

test('empty blog works (public and admin)', async () => {
  const t = await memory();
  assert.match(await (await t.req('/')).text(), /No posts yet/);
  const a = await t.req('/admin');
  assert.equal(a.status, 200);
  assert.match(await a.text(), /No posts yet/);
  await t.stop();
});

test('create: draft appears in admin, slug generated', async () => {
  const t = await memory();
  await mk(t, 'Hello, World!');
  const html = await (await t.req('/admin')).text();
  assert.match(html, /Hello, World!/);
  assert.match(html, /\/posts\/hello-world/);
  assert.match(html, /Draft/);
  await t.stop();
});

test('invalid input rejected', async () => {
  const t = await memory();
  let r = await create(t, { title: '', content: '' });
  assert.equal(r.status, 422);
  const h = await r.text();
  assert.match(h, /Title is required/);
  assert.match(h, /Content is required/);
  r = await create(t, { title: 'x', content: 'y', slug: 'Bad Slug!' });
  assert.equal(r.status, 422);
  assert.match(await r.text(), /Slug may only/);
  await mk(t, 'Dup', 'c', { slug: 'dup' });
  r = await create(t, { title: 'Dup2', content: 'c', slug: 'dup' });
  assert.equal(r.status, 422);
  assert.match(await r.text(), /already in use/);
  assert.equal((await create(t, { title: 'x'.repeat(201), content: 'c' })).status, 422);
  assert.match(await (await t.req('/admin')).text(), /Dup/);
  await t.stop();
});

test('published post appears publicly; unpublished does not', async () => {
  const t = await memory();
  await mk(t, 'Secret');
  const id = await idOf(t, 'Secret');
  assert.doesNotMatch(await (await t.req('/')).text(), /Secret/);
  assert.equal((await t.req('/posts/secret')).status, 404);
  assert.equal((await t.req(`/admin/posts/${id}/publish`, { method: 'POST' })).status, 303);
  assert.match(await (await t.req('/')).text(), /Secret/);
  assert.equal((await t.req('/posts/secret')).status, 200);
  await t.stop();
});

test('publish and unpublish', async () => {
  const t = await memory();
  await mk(t, 'Toggle');
  const id = await idOf(t, 'Toggle');
  await t.req(`/admin/posts/${id}/publish`, { method: 'POST' });
  assert.match(await (await t.req('/admin')).text(), /Published/);
  await t.req(`/admin/posts/${id}/unpublish`, { method: 'POST' });
  assert.match(await (await t.req('/admin')).text(), /Draft/);
  assert.doesNotMatch(await (await t.req('/')).text(), /Toggle/);
  await t.stop();
});

test('individual post page shows title, date, escaped content', async () => {
  const t = await memory();
  await mk(t, 'Page', '<b>bold</b>\n\nSecond para', {});
  await t.req(`/admin/posts/${await idOf(t, 'Page')}/publish`, { method: 'POST' });
  const r = await t.req('/posts/page');
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Page<\/h1>/);
  assert.match(h, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(h, /<time/);
  assert.match(h, /Second para/);
  await t.stop();
});

test('home lists newest published first', async () => {
  const t = await memory();
  for (const n of ['First', 'Second']) {
    await mk(t, n);
    await t.req(`/admin/posts/${await idOf(t, n)}/publish`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 5));
  }
  const h = await (await t.req('/')).text();
  assert.ok(h.indexOf('Second') < h.indexOf('First'));
  await t.stop();
});

test('edit updates post and validates', async () => {
  const t = await memory();
  await mk(t, 'Old');
  const id = await idOf(t, 'Old');
  assert.equal((await t.req(`/admin/posts/${id}/edit`)).status, 200);
  let r = await t.req(`/admin/posts/${id}`, { form: { title: 'New', slug: 'new-slug', content: 'changed' } });
  assert.equal(r.status, 303);
  const h = await (await t.req('/admin')).text();
  assert.match(h, /New/);
  assert.doesNotMatch(h, />Old</);
  r = await t.req(`/admin/posts/${id}`, { form: { title: '', content: 'c' } });
  assert.equal(r.status, 422);
  assert.equal((await t.req('/admin/posts/9999', { form: { title: 'a', content: 'b' } })).status, 404);
  await t.stop();
});

test('delete removes post', async () => {
  const t = await memory();
  await mk(t, 'Gone');
  const id = await idOf(t, 'Gone');
  await t.req(`/admin/posts/${id}/publish`, { method: 'POST' });
  assert.equal((await t.req(`/admin/posts/${id}/delete`, { method: 'POST' })).status, 303);
  assert.equal((await t.req('/posts/gone')).status, 404);
  assert.doesNotMatch(await (await t.req('/admin')).text(), /Gone/);
  assert.equal((await t.req(`/admin/posts/${id}/delete`, { method: 'POST' })).status, 404);
  await t.stop();
});

test('missing post / route / bad id return 404', async () => {
  const t = await memory();
  assert.equal((await t.req('/posts/nope')).status, 404);
  assert.equal((await t.req('/nothing-here')).status, 404);
  assert.equal((await t.req('/admin/posts/abc/edit')).status, 404);
  assert.equal((await t.req('/admin/posts/999/edit')).status, 404);
  await t.stop();
});

test('data survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-'));
  const file = path.join(dir, 'blog.db');
  let t = await start(file);
  await mk(t, 'Durable');
  await t.req(`/admin/posts/${await idOf(t, 'Durable')}/publish`, { method: 'POST' });
  await t.stop();
  t = await start(file);
  assert.match(await (await t.req('/')).text(), /Durable/);
  assert.equal((await t.req('/posts/durable')).status, 200);
  await t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
