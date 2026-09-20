// File-backed post store: one JSON document, atomic writes, serialised mutations.
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const dataFile = () => resolve(process.env.BLOG_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data'), 'posts.json');
let queue = Promise.resolve();

export const slugify = text => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');

async function load() {
  try { return JSON.parse(await readFile(dataFile(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function save(posts) {
  const file = dataFile(); await mkdir(dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(posts, null, 2)); await rename(tmp, file);
}
function mutate(fn) {
  const run = queue.then(async () => { const posts = await load(); const out = await fn(posts); if (out.save !== false) await save(posts); return out.value; });
  queue = run.catch(() => {}); return run;
}

export function validate(input, posts, selfId) {
  const errors = {}, title = String(input.title ?? '').trim(), content = String(input.content ?? '').trim();
  const excerpt = String(input.excerpt ?? '').trim();
  let slug = String(input.slug ?? '').trim().toLowerCase();
  if (!title) errors.title = 'Title is required.'; else if (title.length > 200) errors.title = 'Title must be 200 characters or fewer.';
  if (!content) errors.content = 'Content is required.'; else if (content.length > 100000) errors.content = 'Content is too long.';
  if (excerpt.length > 300) errors.excerpt = 'Excerpt must be 300 characters or fewer.';
  if (!slug && title) slug = slugify(title);
  if (!slug) errors.slug ??= 'Slug is required.';
  else if (slug.length > 80 || !SLUG.test(slug)) errors.slug = 'Slug may use only lowercase letters, digits and single hyphens (max 80).';
  else if (posts.some(p => p.slug === slug && p.id !== selfId)) errors.slug = 'That slug is already in use.';
  return {errors, values: {title, slug, excerpt, content}};
}

export const listPosts = async () => (await load()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const listPublished = async () => (await load()).filter(p => p.published).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
export const getById = async id => (await load()).find(p => p.id === id);
export const getPublishedBySlug = async slug => (await load()).find(p => p.published && p.slug === slug);

export const createPost = input => mutate(posts => {
  const {errors, values} = validate(input, posts);
  if (Object.keys(errors).length) return {save: false, value: {errors, values}};
  const now = new Date().toISOString();
  const post = {id: randomUUID(), ...values, published: false, createdAt: now, updatedAt: now, publishedAt: null};
  posts.push(post); return {value: {post}};
});
export const updatePost = (id, input) => mutate(posts => {
  const post = posts.find(p => p.id === id); if (!post) return {save: false, value: {missing: true}};
  const {errors, values} = validate(input, posts, id);
  if (Object.keys(errors).length) return {save: false, value: {errors, values}};
  Object.assign(post, values, {updatedAt: new Date().toISOString()}); return {value: {post}};
});
export const setPublished = (id, published) => mutate(posts => {
  const post = posts.find(p => p.id === id); if (!post) return {save: false, value: {missing: true}};
  if (post.published !== published) {
    const now = new Date().toISOString(); post.published = published; post.updatedAt = now; post.publishedAt = published ? now : null;
  }
  return {value: {post}};
});
export const deletePost = id => mutate(posts => {
  const i = posts.findIndex(p => p.id === id); if (i < 0) return {save: false, value: {missing: true}};
  posts.splice(i, 1); return {value: {}};
});
