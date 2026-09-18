export default function resource(request, {state}) {
  return Response.json({method: state.method, tunneled: state.method !== request.method});
}
