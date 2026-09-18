// The auth extension has already authorized this request. Credentials never
// reach guest code: Authorization and Cookie are withheld from the sandbox.
export default function profile() {
  return Response.json({signedIn: true, profile: {name: 'Ada', plan: 'team'}});
}
