---
"@jimhoyd/urlcode": patch
---

Fix a crash on Node 22.13.0-22.14.x, a range inside the documented package
floor (`engines`: `>=22.13.0`): every response asked Node's own
`strictContentLength` self-check to revalidate the Content-Length this
runtime had already measured correctly (`http-response.ts`), and Node's own
self-check is broken on exactly that range — it throws
`ERR_HTTP_CONTENT_LENGTH_MISMATCH` from a byte-for-byte-correct response,
deterministically, crashing the process (#645). The self-hosted server and
Vercel writer now skip Node's redundant self-check only on that narrow,
confirmed-broken range (`contentLengthEnforcementIsSafe` in `server.ts`);
the Content-Length this runtime states and sends is unchanged on every Node
version.
