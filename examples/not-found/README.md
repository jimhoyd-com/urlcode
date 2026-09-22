# Custom 404 page

`site.notFound` names an HTML file that answers every GET or HEAD matching no
route, with status 404 and `text/html`. See
[site conventions](../../docs/SITE.md#notfound--404html).

```sh
node packages/core/src/cli.ts test --project examples/not-found
node packages/core/src/cli.ts build --target static --project examples/not-found   # writes 404.html
```
