import { notes, nextId, validate } from './store.mjs';

async function parsed(request) {
  const input = await request.json(), errors = validate(input);
  return errors.length ? { error: Response.json({ errors }, { status: 422 }) } : { note: { title: input.title, body: input.body } };
}

export async function collection(request) {
  if (request.method !== 'POST') return Response.json(notes);
  const { error, note } = await parsed(request);
  return error || Response.json({ id: nextId(), ...note }, { status: 201 });
}

export async function item(request, { args }) {
  if (!/^[1-9][0-9]*$/.test(args.id)) return new Response('Invalid id\n', { status: 400 });
  const id = Number(args.id), existing = notes.find(n => n.id === id);
  if (!existing) return new Response('Not found\n', { status: 404 });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'PUT') return Response.json(existing);
  const { error, note } = await parsed(request);
  return error || Response.json({ id, ...note });
}
