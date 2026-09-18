// In-memory store seeded with two notes; the record rules live here too.
const seed = [
  { id: 1, title: 'Shopping', body: 'milk, bread' },
  { id: 2, title: 'Ideas', body: 'benchmark the plumbing' },
];
export class Notes {
  constructor() { this.rows = new Map(seed.map(n => [n.id, { ...n }])); this.next = seed.length + 1; }
  list() { return [...this.rows.values()].sort((a, b) => a.id - b.id); }
  get(id) { return this.rows.get(id); }
  create(note) { const row = { id: this.next++, ...note }; this.rows.set(row.id, row); return row; }
  replace(id, note) { if (!this.rows.has(id)) return undefined; const row = { id, ...note }; this.rows.set(id, row); return row; }
  remove(id) { return this.rows.delete(id); }
}
export function validate(input) {
  const errors = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['body must be an object'];
  if (typeof input.title !== 'string' || input.title.length < 1 || input.title.length > 120) errors.push('title must be 1-120 characters');
  if (typeof input.body !== 'string' || input.body.length > 2000) errors.push('body must be at most 2000 characters');
  for (const key of Object.keys(input)) if (key !== 'title' && key !== 'body') errors.push('unknown field ' + key);
  return errors;
}
