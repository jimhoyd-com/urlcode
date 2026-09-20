const express = require('express');
const { openDb, createStore } = require('./db');
const { validatePost } = require('./validate');
const v = require('./views');

function createApp({ dbFile = process.env.BLOG_DB || './data/blog.db' } = {}) {
  const db = openDb(dbFile);
  const store = createStore(db);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  const parseId = (s) => (/^\d+$/.test(s) ? Number(s) : null);
  const loadPost = (req, res, next) => {
    const id = parseId(req.params.id);
    const p = id && store.getById(id);
    if (!p) return res.status(404).send(v.notFound('Post not found'));
    req.post = p;
    next();
  };
  const html = (res, status, body) => res.status(status).type('html').send(body);

  // Public
  app.get('/', (req, res) => html(res, 200, v.home(store.listPublished())));
  app.get('/posts/:slug', (req, res) => {
    const p = store.getBySlug(req.params.slug);
    if (!p || !p.published) return html(res, 404, v.notFound('Post not found'));
    html(res, 200, v.postPage(p));
  });

  // Management
  app.get('/admin', (req, res) => html(res, 200, v.adminList(store.listAll(), req.query.msg)));
  app.get('/admin/posts/new', (req, res) => html(res, 200, v.adminForm({})));
  app.post('/admin/posts', (req, res) => {
    const { values, errors } = validatePost(req.body, store);
    if (Object.keys(errors).length) return html(res, 422, v.adminForm({ values, errors }));
    store.create(values);
    res.redirect(303, '/admin?msg=Post+created');
  });
  app.get('/admin/posts/:id/edit', loadPost, (req, res) =>
    html(res, 200, v.adminForm({ values: req.post, id: req.post.id })));
  app.post('/admin/posts/:id', loadPost, (req, res) => {
    const { values, errors } = validatePost(req.body, store, req.post.id);
    if (Object.keys(errors).length) return html(res, 422, v.adminForm({ values, errors, id: req.post.id }));
    store.update(req.post.id, values);
    res.redirect(303, '/admin?msg=Post+updated');
  });
  app.post('/admin/posts/:id/delete', loadPost, (req, res) => {
    store.remove(req.post.id);
    res.redirect(303, '/admin?msg=Post+deleted');
  });
  app.post('/admin/posts/:id/publish', loadPost, (req, res) => {
    if (!req.post.published) store.setPublished(req.post.id, true);
    res.redirect(303, '/admin?msg=Post+published');
  });
  app.post('/admin/posts/:id/unpublish', loadPost, (req, res) => {
    if (req.post.published) store.setPublished(req.post.id, false);
    res.redirect(303, '/admin?msg=Post+unpublished');
  });

  app.use((req, res) => html(res, 404, v.notFound()));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    html(res, status, v.errorPage(status, status >= 500 ? 'Something went wrong.' : err.message));
  });

  app.close = () => db.close();
  return app;
}

module.exports = { createApp };
