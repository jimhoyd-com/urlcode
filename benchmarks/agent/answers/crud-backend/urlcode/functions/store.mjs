// The seed and the record rules. Storage comes later; every request sees the seed.
export const notes = [
  { id: 1, title: 'Shopping', body: 'milk, bread' },
  { id: 2, title: 'Ideas', body: 'benchmark the plumbing' },
];
export const nextId = () => notes.length + 1;
export function validate(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['body must be an object'];
  if (typeof input.title !== 'string' || input.title.length < 1 || input.title.length > 120) errors.push('title must be 1-120 characters');
  if (typeof input.body !== 'string' || input.body.length > 2000) errors.push('body must be at most 2000 characters');
  for (const key of Object.keys(input)) if (key !== 'title' && key !== 'body') errors.push('unknown field ' + key);
  return errors;
}
