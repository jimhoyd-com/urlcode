// Route handlers for the blog. Rendering uses @jimhoyd/urlcode-ui (escaped, responsive document kit).
import {alert, button, createPresentation, emptyState, escapeHtml, navigation, renderDocument} from '@jimhoyd/urlcode-ui';
import * as store from './store.mjs';

const presentation = createPresentation({defaults: {}}).resolve();
const EXTRA_CSS = 'article p{line-height:1.6}.post-list{list-style:none;padding:0}.post-list li{margin:0 0 1.5rem}.meta{color:#666;font-size:.9rem}textarea{width:100%;box-sizing:border-box;min-height:14rem;font:inherit}.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.row form{margin:0}table{width:100%}';
const nav = [{href: '/', label: 'Blog'}, {href: '/admin', label: 'Manage'}];

const html = (title, body, status = 200) => {
  const doc = renderDocument({title, presentation, layout: 'default', trustedContent: navigation(nav, 'Site') + body})
    .replace('</head>', `<style>${EXTRA_CSS}</style></head>`);
  return new Response(doc, {status, headers: {'Content-Type': 'text/html; charset=utf-8'}});
};
const see = location => new Response(null, {status: 303, headers: {Location: location}});
const date = iso => iso ? new Date(iso).toISOString().slice(0, 10) : '';
const paragraphs = text => text.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
const notFound = what => html('Not found', `<h1>Not found</h1>${alert(`${what} does not exist.`, 'error')}<p><a href="/">Back to the blog</a></p>`, 404);
const form = async request => Object.fromEntries(new URLSearchParams(await request.text()));
const excerptOf = p => p.excerpt || (p.content.length > 200 ? p.content.slice(0, 200).replace(/\s+\S*$/, '') + '…' : p.content);

// ---- public
export async function index() {
  const posts = await store.listPublished();
  const items = posts.map(p => `<li><h2><a href="/posts/${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a></h2><p class="meta"><time datetime="${p.publishedAt}">${date(p.publishedAt)}</time></p><p>${escapeHtml(excerptOf(p))}</p></li>`).join('');
  return html('Blog', `<h1>Blog</h1>${posts.length ? `<ul class="post-list">${items}</ul>` : emptyState('No posts have been published yet.')}`);
}
export async function post(request, {args}) {
  const p = await store.getPublishedBySlug(args.slug);
  if (!p) return notFound('That post');
  return html(p.title, `<article><h1>${escapeHtml(p.title)}</h1><p class="meta"><time datetime="${p.publishedAt}">${date(p.publishedAt)}</time></p>${paragraphs(p.content)}</article><p><a href="/">All posts</a></p>`);
}

// ---- management
const editor = (values, errors, action, label) => {
  const err = k => errors[k] ? `<p role="alert" class="error">${escapeHtml(errors[k])}</p>` : '';
  const input = (k, text, req) => `<div class="ui-field"><label for="f-${k}">${text}</label><input data-slot="input" id="f-${k}" name="${k}" maxlength="${k === 'title' ? 200 : k === 'slug' ? 80 : 300}" value="${escapeHtml(values[k] ?? '')}"${req ? ' required' : ''}>${err(k)}</div>`;
  return `<form method="post" action="${action}" class="ui-stack">${input('title', 'Title', true)}${input('slug', 'Slug (blank = from title)')}${input('excerpt', 'Excerpt (blank = start of content)')}<div class="ui-field"><label for="f-content">Content</label><textarea id="f-content" name="content" required maxlength="100000">${escapeHtml(values.content ?? '')}</textarea>${err('content')}</div>${button(label)}</form>`;
};
const postForm = (action, label, destructive) => `<form method="post" action="${action}">${destructive ? button(label).replace('<button ', '<button class="ui-button-destructive" ') : button(label)}</form>`;

export async function admin() {
  const posts = await store.listPosts();
  const rows = posts.map(p => `<tr><td><a href="/admin/posts/${p.id}">${escapeHtml(p.title)}</a><br><span class="meta">/${escapeHtml(p.slug)} · updated ${date(p.updatedAt)}</span></td><td>${p.published ? `<a href="/posts/${encodeURIComponent(p.slug)}">Published ${date(p.publishedAt)}</a>` : 'Draft'}</td><td><div class="row"><a href="/admin/posts/${p.id}">Edit</a>${p.published ? postForm(`/admin/posts/${p.id}/unpublish`, 'Unpublish') : postForm(`/admin/posts/${p.id}/publish`, 'Publish')}${postForm(`/admin/posts/${p.id}/delete`, 'Delete', true)}</div></td></tr>`).join('');
  return html('Manage posts', `<h1>Manage posts</h1><p><a href="/admin/new">New post</a></p>${posts.length ? `<div class="ui-table"><table><thead><tr><th>Post</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('No posts yet.')}`);
}
export const newForm = () => html('New post', `<h1>New post</h1>${editor({}, {}, '/admin/posts', 'Create post')}`);
export async function create(request) {
  const result = await store.createPost(await form(request));
  if (result.errors) return html('New post', `<h1>New post</h1>${alert('Please fix the errors below.', 'error')}${editor(result.values, result.errors, '/admin/posts', 'Create post')}`, 422);
  return see('/admin');
}
export async function editForm(request, {args}) {
  const p = await store.getById(args.id); if (!p) return notFound('That post');
  return html('Edit post', `<h1>Edit post</h1>${editor(p, {}, `/admin/posts/${p.id}`, 'Save changes')}`);
}
export async function update(request, {args}) {
  const input = await form(request), result = await store.updatePost(args.id, input);
  if (result.missing) return notFound('That post');
  if (result.errors) return html('Edit post', `<h1>Edit post</h1>${alert('Please fix the errors below.', 'error')}${editor(result.values, result.errors, `/admin/posts/${args.id}`, 'Save changes')}`, 422);
  return see('/admin');
}
export async function publish(request, {args}) { return (await store.setPublished(args.id, true)).missing ? notFound('That post') : see('/admin'); }
export async function unpublish(request, {args}) { return (await store.setPublished(args.id, false)).missing ? notFound('That post') : see('/admin'); }
export async function remove(request, {args}) { return (await store.deletePost(args.id)).missing ? notFound('That post') : see('/admin'); }
export const editOrUpdate = (request, context) => request.method === 'POST' ? update(request, context) : editForm(request, context);
