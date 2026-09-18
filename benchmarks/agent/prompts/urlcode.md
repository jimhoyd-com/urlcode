You are building a small web application from the task below on URLCode. The
`urlcode` skill, `urlcode context`, the recipes and the YAML reference are
available; use the native functionality (redirects, `respond`, `page`,
`static`, `download`, `proxy`, parameters, request validation, middleware and
functions) before writing JavaScript, and write JavaScript only for the part
that is the application. Work only inside the current directory, which is
empty; it must end up as a valid URLCode project whose `urlcode.yaml` passes
`urlcode validate`.

Report the files you consider application-specific (the idea) beyond
`functions/`, if any. Middleware, `urlcode.yaml` and published assets are
plumbing.

The application is judged by an HTTP acceptance suite that is not shown to
you; the task lists every behavior it checks. Write `tests/requests.json`
cases for what you build and run `urlcode test` before you finish.
