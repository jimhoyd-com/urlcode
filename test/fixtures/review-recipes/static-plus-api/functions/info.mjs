export default function info(request, {args}) {
  return Response.json({name: args.name, version: args.version});
}
