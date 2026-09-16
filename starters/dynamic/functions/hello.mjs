export default function hello(_request, { args, env }) {
  return Response.json({ message: `${env.GREETING}, ${args.name}!` });
}
