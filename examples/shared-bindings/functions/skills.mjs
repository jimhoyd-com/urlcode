// Every export reads the same inherited bindings from its context: SKILLS and
// REGION come from the shared `skills` block, resolved into each route.
const enabled = env => env.SKILLS.split(',').map(skill => skill.trim()).filter(Boolean);

export default function list(request, {env}) {
  return Response.json({skills: enabled(env)});
}

export function check(request, {args, env}) {
  const on = enabled(env).includes(args.name);
  return Response.json({skill: args.name, enabled: on}, {status: on ? 200 : 404});
}

export function status(request, {env}) {
  return Response.json({region: env.REGION, skills: enabled(env).length});
}
