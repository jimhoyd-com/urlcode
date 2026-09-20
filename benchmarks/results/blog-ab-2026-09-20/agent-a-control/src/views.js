const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';

const excerpt = (text, n = 200) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n).replace(/\s+\S*$/, '') + '…';
};

const paragraphs = (text) =>
  text.split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n');

const CSS = `
*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,sans-serif;color:#222;background:#fafafa}
a{color:#0b5fff}header.site{background:#fff;border-bottom:1px solid #ddd}
.wrap{max-width:720px;margin:0 auto;padding:1rem}
header.site .wrap{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem}
header.site a{text-decoration:none;font-weight:600}h1{line-height:1.2}
.meta{color:#666;font-size:.9rem}article.entry{margin-bottom:2rem}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #ddd;vertical-align:top}
.actions{display:flex;gap:.4rem;flex-wrap:wrap}.actions form{margin:0}
button,.btn{font:inherit;font-size:.9rem;padding:.3rem .7rem;border:1px solid #888;border-radius:4px;background:#fff;cursor:pointer;text-decoration:none;color:#222;display:inline-block}
button.primary{background:#0b5fff;color:#fff;border-color:#0b5fff}button.danger{color:#b00020;border-color:#b00020}
label{display:block;font-weight:600;margin-top:1rem}input[type=text],textarea{width:100%;font:inherit;padding:.5rem;border:1px solid #999;border-radius:4px}
textarea{min-height:14rem}.error{color:#b00020;font-size:.9rem;margin:.2rem 0 0}.flash{background:#e6f4ea;padding:.5rem 1rem;border-radius:4px}
.badge{font-size:.75rem;padding:.1rem .5rem;border-radius:1rem;background:#eee}.badge.pub{background:#d7f0dc}
@media(max-width:600px){.hide-sm{display:none}body{font-size:16px}}`;

function layout(title, body, { admin = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>
<header class="site"><div class="wrap"><a href="/">My Blog</a><a href="/admin">Manage posts</a></div></header>
<main class="wrap">${body}</main></body></html>`;
}

const home = (posts) =>
  layout('My Blog', `<h1>Latest posts</h1>` +
    (posts.length
      ? posts.map((p) => `<article class="entry"><h2><a href="/posts/${esc(p.slug)}">${esc(p.title)}</a></h2>
<div class="meta"><time datetime="${esc(p.published_at)}">${fmtDate(p.published_at)}</time></div>
<p>${esc(excerpt(p.content))}</p><a href="/posts/${esc(p.slug)}">Read more</a></article>`).join('\n')
      : '<p>No posts yet.</p>'));

const postPage = (p) =>
  layout(p.title, `<article><h1>${esc(p.title)}</h1>
<div class="meta"><time datetime="${esc(p.published_at)}">${fmtDate(p.published_at)}</time></div>
${paragraphs(p.content)}</article><p><a href="/">&larr; All posts</a></p>`);

const notFound = (msg = 'Page not found') =>
  layout('Not found', `<h1>404</h1><p>${esc(msg)}</p><p><a href="/">Back to the blog</a></p>`);

const errorPage = (status, msg) => layout(`Error ${status}`, `<h1>Error ${status}</h1><p>${esc(msg)}</p>`);

const post = (action, label) =>
  `<form method="post" action="${action}"><button ${label === 'Delete' ? 'class="danger" ' : ''}type="submit"${label === 'Delete' ? ` onclick="return confirm('Delete this post?')"` : ''}>${label}</button></form>`;

const adminList = (posts, flash) =>
  layout('Manage posts', `<h1>Posts</h1>${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
<p><a class="btn primary" href="/admin/posts/new">New post</a></p>` +
    (posts.length
      ? `<table><thead><tr><th>Title</th><th class="hide-sm">Status</th><th>Actions</th></tr></thead><tbody>` +
        posts.map((p) => `<tr><td>${esc(p.title)}<div class="meta">/posts/${esc(p.slug)}</div></td>
<td class="hide-sm"><span class="badge${p.published ? ' pub' : ''}">${p.published ? 'Published' : 'Draft'}</span></td>
<td><div class="actions"><a class="btn" href="/admin/posts/${p.id}/edit">Edit</a>
${p.published ? `<a class="btn" href="/posts/${esc(p.slug)}">View</a>` : ''}
${post(`/admin/posts/${p.id}/${p.published ? 'unpublish' : 'publish'}`, p.published ? 'Unpublish' : 'Publish')}
${post(`/admin/posts/${p.id}/delete`, 'Delete')}</div></td></tr>`).join('\n') +
        '</tbody></table>'
      : '<p>No posts yet.</p>'), { admin: true });

const adminForm = ({ values = {}, errors = {}, id = null }) => {
  const err = (k) => (errors[k] ? `<p class="error">${esc(errors[k])}</p>` : '');
  return layout(id ? 'Edit post' : 'New post', `<h1>${id ? 'Edit post' : 'New post'}</h1>
<form method="post" action="${id ? `/admin/posts/${id}` : '/admin/posts'}" novalidate>
<label for="title">Title</label><input type="text" id="title" name="title" value="${esc(values.title)}" required>${err('title')}
<label for="slug">Slug <span class="meta">(optional; generated from title)</span></label><input type="text" id="slug" name="slug" value="${esc(values.slug)}">${err('slug')}
<label for="content">Content</label><textarea id="content" name="content" required>${esc(values.content)}</textarea>${err('content')}
<p class="actions"><button class="primary" type="submit">Save</button><a class="btn" href="/admin">Cancel</a></p></form>`, { admin: true });
};

module.exports = { home, postPage, notFound, errorPage, adminList, adminForm };
