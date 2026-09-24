// Parse a JSON body once and hand the object to the handler through
// context.state. The route's request.body.schema has already checked the shape
// (name 1-80 characters, age an integer from 0 to 150, no other fields) and
// answered 422 before this runs, so nothing here re-validates it. Bodies are
// single-use, so downstream code must not read again.
export default async function parseBody(request, context, next) {
  context.state.body = await request.json();
  return next();
}
