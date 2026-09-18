export const sources = new Set(['github', 'stripe']);
export function acknowledge(source, body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof body.event !== 'string') return { status: 422, body: { errors: ['event is required'] } };
  return { status: 202, body: { received: true, source, event: body.event } };
}
