import { caller, create, database, json, listOwn } from '../lib/requests.mjs';

export default async function requests(request, context) {
  const userId = caller(context);
  if (!userId) return json(401, { error: 'authentication_required' });
  const db = database(context.env.APP_DATABASE);
  if (request.method === 'GET') return json(200, { requests: listOwn(db, userId, context.inputs.query.status) });
  // The route validates a body when one is sent; a POST must send one.
  const text = await request.text();
  if (!text) return json(400, { error: 'body_required' });
  return json(201, create(db, userId, JSON.parse(text)));
}
