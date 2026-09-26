# Streaming progress

`GET /jobs/progress` runs a small job and sends one line per step while it
runs, instead of one response after the last step:

```text
step 1 of 3
step 2 of 3
step 3 of 3
done
```

The route declares `stream: true`, so the runtime sends the function's
Response body as it is produced, with chunked transfer and no
`Content-Length` ([streamed responses](../../docs/SPECIFICATION.md#streamed-responses)).
The function returns an ordinary `Response` whose body is an async generator
wrapped in `ReadableStream.from`. Without `stream: true` the same function
would still work, but the client would see all four lines at once, after the
last step.

The query parameter `steps` (1 to 10, default 3) is declared, so a bad value
answers 400 before any code runs. HEAD answers the status and headers without
running the steps.

`context.signal` aborts when the client disconnects or an operator
[stream limit](../../docs/OPERATIONS.md#streamed-responses) ends the stream;
the loop checks it and stops. The operator sets those limits on the command
line (`--max-streams`, `--stream-idle-timeout-ms`, `--stream-max-duration-ms`,
`--stream-max-bytes`), never in the route.

```sh
urlcode validate --local --project .
urlcode test --project .
urlcode serve --project .
curl -N 'http://127.0.0.1:3000/jobs/progress?steps=5'   # -N prints each line as it arrives
```

Streaming is self-hosted only: the route is a trusted function, and AWS,
Vercel, Cloudflare and static refuse the project before serving rather than
buffering it. `stream: true` cannot be combined with `sandbox: true`.
