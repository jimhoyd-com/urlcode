// A trusted function route using an ordinary npm library through its own API: no URLCode adapter, descriptor,
// catalog entry or wrapper. zod is a dependency of the site (../../package.json), resolved by Node from node_modules.
import * as z from 'zod';

const SignUp = z.object({
  name: z.string().trim().min(1).max(64),
  email: z.email(),
  tags: z.array(z.string().min(1).max(16)).max(5).default([]),
});

export default async function validate(request) {
  let input;
  try { input = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const result = SignUp.safeParse(input);
  if (!result.success) {
    return Response.json({ error: 'invalid', issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })) }, { status: 422 });
  }
  return Response.json({ ok: true, value: result.data });
}
