export function hello(request, {args}) {
  return Response.json({message: `${args.greeting}, ${args.name}${args.excited ? args.punctuation : '.'}`});
}
