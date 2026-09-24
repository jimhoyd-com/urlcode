export default async function validateBody(request, context, next) {
  const body = await request.json();
  const errors = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) errors.push('body must be an object');
  else {
    if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 80) errors.push('name must be 1-80 characters');
    if (body.age !== undefined && (!Number.isInteger(body.age) || body.age < 0 || body.age > 150)) errors.push('age must be an integer from 0 to 150');
    for (const key of Object.keys(body)) if (!['name', 'age'].includes(key)) errors.push('unknown field ' + key);
  }
  if (errors.length) return Response.json({errors}, {status: 422});
  context.state.body = body;
  return next();
}
