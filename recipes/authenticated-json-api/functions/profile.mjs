// The auth extension has already authorized this request and hands the function
// the signed-in user's id. Credentials never reach it: the host strips
// Authorization and Cookie before dispatch, in both execution modes.
export default function profile(_request, context) {
  const {userId} = context.capabilities.auth.identity;
  return Response.json({signedIn: true, userId, profile: {name: 'Ada', plan: 'team'}});
}
