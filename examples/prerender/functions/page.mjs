// One page's content, supplied as reviewed literal arguments in urlcode.yaml.
// This route declares `sandbox: true`, so it runs in the QuickJS/WASM sandbox
// with no filesystem, network or host code, at build time exactly as it would
// at request time. Functions run trusted and unsandboxed by default; this
// example opts back into isolation deliberately.
export function page(request, {args}) {
  return new Response(args.body, {headers: {'content-type': 'text/html; charset=utf-8'}});
}
