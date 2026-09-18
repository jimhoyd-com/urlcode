export default function status() {
  return Response.json({service: 'cookbook', state: 'ok'});
}
