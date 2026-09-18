export const users = [
  { id: 1, name: 'ada', active: true },
  { id: 2, name: 'grace', active: true },
  { id: 3, name: 'linus', active: false },
];
export function list() { return Response.json(users); }
export function disable(request, { args }) {
  if (!/^[1-9][0-9]*$/.test(args.id)) return new Response('Invalid id\n', { status: 400 });
  const user = users.find(u => u.id === Number(args.id));
  return user ? Response.json({ ...user, active: false }) : new Response('Not found\n', { status: 404 });
}
