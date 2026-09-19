// Field checks the runtime does not do: the body limit and JSON syntax are
// enforced before this runs. The declared signal fires after a response with
// a fixed payload (route, method, status); the message itself never leaves
// the signal, so a form store or mailer belongs behind the granted hook rather
// than an ad-hoc call from here.
const emailPattern = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
export default async function contact(request) {
  const body = await request.json();
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({accepted: false, errors: ['body must be a JSON object']}, {status: 422});
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 100) errors.push('name: 1-100 characters');
  if (typeof body.email !== 'string' || !emailPattern.test(body.email)) errors.push('email: a valid address');
  if (typeof body.message !== 'string' || body.message.trim().length < 10 || body.message.length > 4000) errors.push('message: 10-4000 characters');
  if (errors.length) return Response.json({accepted: false, errors}, {status: 422});
  return Response.json({accepted: true}, {status: 202});
}
