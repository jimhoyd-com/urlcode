# Custom 404 page

`site.notFound` names an HTML file that answers every GET or HEAD matching no
route, with status 404 and `text/html`. See
[site conventions](../../docs/SITE.md#notfound--404html).

Copy it with `urlcode examples add not-found --out not-found`, then from that directory:

```sh
urlcode test --project .
urlcode build --target static --project .   # writes 404.html
```
