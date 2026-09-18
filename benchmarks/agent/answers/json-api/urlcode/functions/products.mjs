import { products } from './catalog.mjs';
export function list(request, { args }) {
  return Response.json(args.category === undefined ? products : products.filter(p => p.category === args.category));
}
export function one(request, { args }) {
  // Path inputs are strings; the positive-integer rule is applied here.
  if (!/^[1-9][0-9]*$/.test(args.id)) return new Response('Invalid id\n', { status: 400 });
  const product = products.find(p => p.id === Number(args.id));
  return product ? Response.json(product) : new Response('Not found\n', { status: 404 });
}
