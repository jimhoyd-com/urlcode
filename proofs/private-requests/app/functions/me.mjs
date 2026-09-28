import { caller, database, isReviewer, json } from '../lib/requests.mjs';

export default function me(_request, context) {
  const userId = caller(context);
  if (!userId) return json(401, { error: 'authentication_required' });
  return json(200, { userId, reviewer: isReviewer(database(context.env.APP_DATABASE), userId) });
}
