export default function profile(request, {state}) {
  return Response.json({welcome: state.body.name, age: state.body.age ?? null}, {status: 201});
}
