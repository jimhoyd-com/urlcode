export default (request) =>
  request.method === 'POST' ? new Response('created', { status: 201 }) : new Response('notes');
