import { approve, caller, database, find, isReviewer, json } from '../lib/requests.mjs';

export default function approveRequest(_request, context) {
  const userId = caller(context);
  if (!userId) return json(401, { error: 'authentication_required' });
  const db = database(context.env.APP_DATABASE);
  // Signing in proves who the caller is; reviewing is a separate application permission.
  if (!isReviewer(db, userId)) return json(403, { error: 'reviewer_required' });
  const id = context.inputs.path.id;
  if (approve(db, id, userId)) return json(200, find(db, id));
  const found = find(db, id);
  if (!found) return json(404, { error: 'not_found' });
  if (found.ownerId === userId) return json(403, { error: 'self_approval_refused' });
  return json(409, { error: 'not_pending', status: found.status });
}
