import {sessionUserId} from '@jimhoyd/urlcode-auth';

export default async function echo(request, context) {
  const userId = sessionUserId(request);
  if (!userId) return Response.json({error: 'authentication_required'}, {status: 401});
  return Response.json({userId, label: context.inputs.path.label, received: await request.json()});
}
