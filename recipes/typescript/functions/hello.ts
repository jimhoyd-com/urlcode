interface Greeting { message: string }
export default function hello(): Response {
  const greeting: Greeting = {message: 'Hello from a compiled TypeScript guest'};
  return Response.json(greeting);
}
