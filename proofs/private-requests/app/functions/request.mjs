import { caller, database, find, isReviewer, json } from '../lib/requests.mjs';

export default function request(_request, context) {
  const userId = caller(context);
  if (!userId) return json(401, { error: 'authentication_required' });
  const db = database(context.env.APP_DATABASE);
  const found = find(db, context.inputs.path.id);
  // Another owner's request is indistinguishable from a missing one.
  if (!found || found.ownerId !== userId && !isReviewer(db, userId)) return json(404, { error: 'not_found' });
  return json(200, found);
}
