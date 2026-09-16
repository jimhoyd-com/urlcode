export default function hello(request, { args }) {
  return Response.json({ message: `Hello, ${args.name}!` });
}
