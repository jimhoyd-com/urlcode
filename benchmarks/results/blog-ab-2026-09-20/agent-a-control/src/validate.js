const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

// Returns { values, errors }. errors is {} when valid.
function validatePost(body, store, currentId) {
  const title = String(body.title ?? '').trim();
  const content = String(body.content ?? '').trim();
  let slug = String(body.slug ?? '').trim().toLowerCase();
  const errors = {};
  if (!title) errors.title = 'Title is required.';
  else if (title.length > 200) errors.title = 'Title must be at most 200 characters.';
  if (!content) errors.content = 'Content is required.';
  if (!slug && title) slug = slugify(title);
  if (!slug) errors.slug = errors.title ? 'Slug is required.' : 'Could not derive a slug; enter one.';
  else if (slug.length > 80) errors.slug = 'Slug must be at most 80 characters.';
  else if (!SLUG_RE.test(slug)) errors.slug = 'Slug may only contain lowercase letters, digits and single hyphens.';
  else {
    const other = store.getBySlug(slug);
    if (other && other.id !== currentId) errors.slug = 'Slug is already in use.';
  }
  return { values: { title, slug, content }, errors };
}

module.exports = { validatePost, slugify, SLUG_RE };
