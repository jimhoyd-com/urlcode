# Static page

Run `urlcode validate --local --project .`, `urlcode test --project .` and
`urlcode audit --project . --expect-routes 1`.

`/` serves `public/index.html` with the native `page` handler, so no project
code runs. Edit the file to change the page. For a whole directory of assets use
`static`; for fixed text or JSON use `respond`; for an attachment use
`download`. The `static-plus-api` recipe combines a page with a directory.
