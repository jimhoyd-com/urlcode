import { caller, database, isReviewer, json, listPending } from '../lib/requests.mjs';

export default function pending(_request, context) {
  const userId = caller(context);
  if (!userId) return json(401, { error: 'authentication_required' });
  const db = database(context.env.APP_DATABASE);
  if (!isReviewer(db, userId)) return json(403, { error: 'reviewer_required' });
  return json(200, { requests: listPending(db) });
}
