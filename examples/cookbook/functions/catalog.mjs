export default function catalog() {
  return Response.json({version: 3, items: ['alpha', 'beta']});
}
