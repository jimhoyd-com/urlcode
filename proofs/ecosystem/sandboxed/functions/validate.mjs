// The same direct library import as ../../app/functions/validate.mjs, on a route that opts into the sandbox.
import * as z from 'zod';

const SignUp = z.object({ name: z.string().min(1), email: z.email() });

export default async function validate(request) {
  return Response.json(SignUp.safeParse(await request.json()));
}
