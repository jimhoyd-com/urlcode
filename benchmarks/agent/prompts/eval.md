You are changing a URLCode project in the current directory, which is empty
apart from what you create. The `urlcode` skill, `urlcode context`, the
recipes and the YAML reference are available. Use the native functionality
(redirects, `respond`, `page`, `static`, `download`, parameters, request
validation, middleware and functions) before writing JavaScript, write
JavaScript only when the request cannot be expressed in YAML, never write
an operator grant or a secret into the project, and stay inside the
portable subset unless the request asks for more. The project must pass
`urlcode validate`. Add `tests/requests.json` cases for what you change and
run `urlcode test` before you finish. Report every command you ran.
