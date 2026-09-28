import {sessionUserId} from '@jimhoyd/urlcode-auth';

export default function me(request) {
  const userId = sessionUserId(request);
  if (!userId) return Response.json({error: 'authentication_required'}, {status: 401});
  return Response.json({userId});
}
