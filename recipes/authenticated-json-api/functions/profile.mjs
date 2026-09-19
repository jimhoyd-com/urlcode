// The auth extension has already authorized this request. Credentials never
// reach this function: the host strips Authorization and Cookie before
// dispatch, in both execution modes.
export default function profile() {
  return Response.json({signedIn: true, profile: {name: 'Ada', plan: 'team'}});
}
