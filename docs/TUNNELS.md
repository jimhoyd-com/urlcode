# Public tunnels for local development

A tunnel gives a project running on your machine a public HTTPS address, which
is what you need to test redirects from a phone, receive a provider's webhook,
complete an OAuth callback or show someone a work in progress.

URLCode has one requirement that matters here, and one warning.

## Always pass `--origin`

Forwarded headers are deliberately not trusted, so the runtime cannot infer its
public address. Without `--origin`, functions receive `http://127.0.0.1:3000/...`
as `request.url` even though the visitor arrived over HTTPS at a public host —
so anything built from the request URL is wrong: OAuth redirect URIs, absolute
links in generated HTML, canonical URLs, signature checks.

```sh
urlcode dev --project app --origin https://your-subdomain.ngrok-free.app
```

The startup record reports what was chosen, so you can confirm it:

```json
{"event":"listening","address":"127.0.0.1","port":3000,"mode":"dev","origin":"https://your-subdomain.ngrok-free.app"}
```

`--origin` must be a bare HTTP(S) origin: no path, no credentials, no trailing
slash. It works with `serve` too, and behind a reverse proxy it is the same
mechanism.

## ngrok

Start the tunnel, then start URLCode with the origin it gave you:

```sh
ngrok http 3000
urlcode dev --project app --origin https://your-subdomain.ngrok-free.app
```

Because that address changes on every restart of a free tunnel,
[`examples/tunnel/dev-with-ngrok.sh`](../examples/tunnel/dev-with-ngrok.sh)
reads it from the ngrok agent's local API and passes it for you:

```sh
ngrok http 3000                       # terminal 1
PROJECT=. ./examples/tunnel/dev-with-ngrok.sh   # terminal 2
```

It selects the HTTPS tunnel forwarding to your port and refuses to guess when
there is no match, so a second unrelated tunnel on the same agent cannot send
your traffic somewhere unexpected. `--print` shows the resolved origin without
starting anything. It discovers a tunnel; it does not start, stop or configure
ngrok, and it holds no ngrok credentials.

Other tunnels — Cloudflare Tunnel, Tailscale Funnel, localtunnel, an SSH remote
forward — work the same way: get the public origin, pass it to `--origin`.

## What you are exposing

A tunnel makes a development server reachable by anyone with the URL, including
scanners that find it within minutes.

- `dev` loads `.env.local` and watches files. Any secret in that file is
  available to the functions you just published.
- The runtime has **no authentication and no rate limiting**. Put access control
  in the tunnel: ngrok's OAuth, OIDC or basic auth; Cloudflare Access; a
  Tailscale ACL.
- Prefer `serve` with a fixed snapshot, a project containing no real secrets,
  and a tunnel you shut down when finished.

A tunnel is for development and demos. For a real deployment, terminate TLS at a
proxy you control and read [operations](OPERATIONS.md).
