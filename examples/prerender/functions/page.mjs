// One page's content, supplied as reviewed literal arguments in urlcode.yaml.
// This runs trusted and in-process -- the default for a function route -- at
// build time exactly as it would at request time. It reads nothing but its
// own args, so there is nothing here for `sandbox: true` to isolate; adding it
// would cost worker-pool capacity for no gain.
export function page(request, {args}) {
  return new Response(args.body, {headers: {'content-type': 'text/html; charset=utf-8'}});
}
