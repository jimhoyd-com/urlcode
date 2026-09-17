#!/bin/sh
# Start `urlcode dev` with the public origin of an ngrok tunnel that is already
# running, so functions, redirects and absolute URLs see the address a visitor
# actually used rather than 127.0.0.1.
#
#   Terminal 1:  ngrok http 3000
#   Terminal 2:  PROJECT=. ./dev-with-ngrok.sh
#
# This script discovers a tunnel; it does not start, stop or configure ngrok.
# That keeps it honest about what it controls and leaves the tunnel's own
# authentication and access policy where it belongs: in ngrok.
set -eu

PROJECT=${PROJECT:-.}
PORT=${PORT:-3000}
URLCODE=${URLCODE:-urlcode}
# The ngrok agent's local inspection API. Overridable for a different agent port
# or for this repository's test, which serves a recorded response.
NGROK_API=${URLCODE_NGROK_API:-http://127.0.0.1:4040/api/tunnels}
PRINT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --print) PRINT_ONLY=1; shift ;;
    --help|-h) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "dev-with-ngrok: unknown option $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "dev-with-ngrok: node is required" >&2; exit 1; }

# Select the HTTPS tunnel that forwards to this port. Anything else is a
# different tunnel on the same agent and must not be guessed at.
ORIGIN=$(NGROK_API="$NGROK_API" PORT="$PORT" node -e '
  const api = process.env.NGROK_API, port = process.env.PORT;
  fetch(api, {headers:{accept:"application/json"}})
    .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
    .then(body => {
      const tunnels = Array.isArray(body?.tunnels) ? body.tunnels : [];
      const match = tunnels.find(t =>
        typeof t?.public_url === "string" && t.public_url.startsWith("https://") &&
        typeof t?.config?.addr === "string" && new RegExp(`(^|[^0-9])${port}$`).test(t.config.addr));
      if (!match) throw new Error(`no https tunnel forwarding to port ${port}`);
      const url = new URL(match.public_url);
      if (url.origin !== match.public_url.replace(/\/$/,"")) throw new Error("tunnel URL is not a bare origin");
      process.stdout.write(url.origin);
    })
    .catch(e => { console.error("dev-with-ngrok: " + e.message); process.exit(1); });
') || {
  echo "dev-with-ngrok: could not read a tunnel from $NGROK_API" >&2
  echo "  start one first, e.g.  ngrok http $PORT" >&2
  exit 1
}

echo "dev-with-ngrok: public origin $ORIGIN"
if [ "$PRINT_ONLY" -eq 1 ]; then exit 0; fi

# dev loads .env.local and watches files. A tunnel makes that reachable from the
# internet: expose a development project only deliberately, and never tunnel the
# separate link-management API.
exec "$URLCODE" dev --project "$PROJECT" --port "$PORT" --origin "$ORIGIN"
