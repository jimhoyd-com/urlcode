// The shared site template. It wraps a function response, whose body is
// readable through text(); a native page/static/download body is deliberately
// opaque, which is why the template is applied here, before prerendering, and
// never to the generated files.
const escape = value => String(value).replace(/[&<>"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[character]));
export async function template(request, context, next) {
  const response = await next();
  // Never wrap a failed render: the build must see the original status and stop.
  if (!response.ok) return response;
  const content = await response.text();
  const title = escape(context.args.title);
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
<header><a href="/">URLCode prerender example</a></header>
<main>
<h1>${title}</h1>
${content}
</main>
<footer>Prerendered at build time. No project code runs to serve this page.</footer>
</body>
</html>
`, {status: response.status, headers: {'content-type': 'text/html; charset=utf-8'}});
}
