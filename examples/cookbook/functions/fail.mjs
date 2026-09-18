export default function fail(request, {args}) {
  if (args.fail) throw new Error('simulated failure');
  return Response.json({healthy: true});
}
