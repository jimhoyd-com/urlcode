#!/bin/sh
# URLCode installer. Downloads a published release tarball, verifies its
# SHA-256 against a same-origin SHA256SUMS file (protects against a corrupted
# or truncated download, not against a compromised or substituted origin),
# and installs the CLI with npm. Every release is separately attested by
# GitHub. Pass --verify-attestation to check that signed provenance during
# install with the `gh` CLI, or run `gh attestation verify` yourself
# afterwards; this is opt-in because it needs a network call to GitHub and an
# authenticated `gh`, neither of which this script otherwise requires.
#
#   curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/urlcode/main/install.sh | sh
#   ... | sh -s -- --version 0.3.0 --prefix "$HOME/.local"   # pin a release; omit --version for the latest
#
# This script never runs project code and never needs root for a --prefix install.
# Everything below runs inside main() at the bottom of the file, so a
# truncated `curl | sh` download (a partial script body) fails to call main
# and does nothing, rather than executing partial top-level statements.
set -eu

REPO=jimhoyd-com/urlcode
VERSION=""
PREFIX=""
VERIFY_ATTESTATION=""
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13

usage() {
  cat <<'USAGE'
Usage: install.sh [--version X.Y.Z] [--prefix DIR] [--verify-attestation]

  --version             Release to install. Defaults to the latest published release.
  --prefix              Install into DIR/lib/node_modules and link DIR/bin/urlcode.
                        Defaults to the npm global prefix, which may require privileges.
  --verify-attestation  Also verify the release's signed GitHub attestation with
                        `gh attestation verify` before installing. Requires an
                        authenticated `gh` and a network call to GitHub.
  --help                Show this message.
USAGE
}

# Everything the installer does lives in main(), called with the script's
# original arguments at the bottom of this file. A `curl | sh` pipe that is
# truncated mid-download yields a body with no trailing `main "$@"` call (or
# a syntactically incomplete one), so the shell never executes a partial
# install — unlike top-level statements, which run as they are parsed.
main() {

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { echo "install: --version needs a value" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
    --prefix)  [ $# -ge 2 ] || { echo "install: --prefix needs a value" >&2; exit 2; }; PREFIX="$2"; shift 2 ;;
    --verify-attestation) VERIFY_ATTESTATION=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "install: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

version_is_safe() { case "$1" in *[!0-9A-Za-z.+-]*|"") return 1 ;; *) return 0 ;; esac; }
if [ -n "$VERSION" ] && ! version_is_safe "$VERSION"; then
  echo "install: refusing suspicious version '$VERSION'" >&2; exit 2
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "install: $1 is required" >&2; exit 1; }; }
need node
need npm

# Prefer a real download tool, but fall back to node, which is already required.
# Slim container images ship neither curl nor wget, and that must not stop an install.
# Transport is pinned to the URL's own scheme: https gets a minimum TLS
# version and a locked-down protocol list, and the loopback/file exceptions
# carved out below (for mirrors and this repository's own installer test)
# still only ever speak the scheme they were validated for.
if command -v curl >/dev/null 2>&1; then
  fetch() {
    case "$1" in
      https://*) curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2" ;;
      *)         curl -fsSL --proto '=http,file' "$1" -o "$2" ;;
    esac
  }
elif command -v wget >/dev/null 2>&1; then
  fetch() {
    case "$1" in
      https://*) wget -qO "$2" --https-only "$1" ;;
      *)         wget -qO "$2" "$1" ;;
    esac
  }
else fetch() {
  node -e '
    const {writeFileSync} = require("node:fs");
    fetch(process.argv[1])
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error("HTTP " + r.status)))
      .then(body => writeFileSync(process.argv[2], Buffer.from(body)))
      .catch(e => { console.error("install: download failed: " + e.message); process.exit(1); });
  ' "$1" "$2"
}
fi

node_version=$(node -p 'process.versions.node')
node_major=${node_version%%.*}
node_rest=${node_version#*.}
node_minor=${node_rest%%.*}
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ] || { [ "$node_major" -eq "$MIN_NODE_MAJOR" ] && [ "$node_minor" -lt "$MIN_NODE_MINOR" ]; }; then
  echo "install: Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer is required; found $node_version" >&2
  exit 1
fi

if [ -z "$VERSION" ]; then
  VERSION=$(node -e "
    const url='https://api.github.com/repos/$REPO/releases/latest';
    fetch(url,{headers:{'user-agent':'urlcode-install'}})
      .then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status)))
      .then(r=>{const t=String(r.tag_name||'');if(!/^v\d+\.\d+\.\d+/.test(t))throw new Error('unexpected tag '+t);process.stdout.write(t.slice(1));})
      .catch(e=>{console.error('install: cannot resolve latest release: '+e.message);process.exit(1);});
  ")
fi
# Re-check after resolution: a released tag is input too.
version_is_safe "$VERSION" || { echo "install: refusing suspicious version '$VERSION'" >&2; exit 2; }

# The release asset is npm's packed name: a scope becomes a leading segment
# joined by a dash. test/release.test.ts holds this to package.json.
TARBALL="jimhoyd-urlcode-$VERSION.tgz"
# URLCODE_DOWNLOAD_BASE serves mirrors and this repository's own installer test.
# It replaces both the tarball and the SHA256SUMS it is checked against, so a
# base you do not control is a base you are trusting: verify the release's
# signed provenance with `gh attestation verify` (or --verify-attestation)
# after installing. Only https:// bases are trusted in general; loopback
# http:// and file:// are additionally allowed because they cannot be
# intercepted off-host and this script's own tests rely on a loopback server.
# A loopback host must be followed by a port, a path or nothing, so a name
# that merely starts with it (http://localhost.example.tld) is refused.
BASE="${URLCODE_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/v$VERSION}"
case "$BASE" in
  https://*) ;;
  http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*) ;;
  http://localhost|http://localhost:*|http://localhost/*) ;;
  'http://[::1]'|'http://[::1]:'*|'http://[::1]/'*|file://*) ;;
  *) echo "install: URLCODE_DOWNLOAD_BASE must be https:// (loopback http:// and file:// are allowed for local testing)" >&2; exit 2 ;;
esac
TMP=$(mktemp -d "${TMPDIR:-/tmp}/urlcode-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "install: downloading $TARBALL"
fetch "$BASE/$TARBALL" "$TMP/$TARBALL"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$TMP/$TARBALL" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$TMP/$TARBALL" | cut -d' ' -f1)
else actual=$(node -e "const{createHash}=require('node:crypto'),{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$TMP/$TARBALL")
fi
expected=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *"  $TARBALL") expected=${line%% *} ;;
  esac
done < "$TMP/SHA256SUMS"
if [ -z "$expected" ]; then echo "install: $TARBALL is not listed in SHA256SUMS" >&2; exit 1; fi
if [ "$actual" != "$expected" ]; then
  echo "install: checksum mismatch for $TARBALL" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  exit 1
fi
echo "install: checksum verified (same-origin SHA256SUMS; catches corruption, not a substituted origin)"

if [ -n "$VERIFY_ATTESTATION" ]; then
  need gh
  echo "install: verifying signed GitHub attestation for $TARBALL"
  gh attestation verify "$TMP/$TARBALL" --repo "$REPO"
  echo "install: attestation verified"
fi

# --ignore-scripts: a package install must not execute lifecycle code.
# The published tarball pins its direct dependencies exactly but does not
# ship a lockfile, so transitive versions resolve at install time from the
# npm registry rather than from bytes this release fixed; review
# `npm ls --all` after installing if that matters for your environment.
if [ -n "$PREFIX" ]; then
  npm install --global --ignore-scripts --no-audit --no-fund --prefix "$PREFIX" "$TMP/$TARBALL"
  echo "install: urlcode $VERSION installed; add $PREFIX/bin to PATH if it is not already there"
else
  npm install --global --ignore-scripts --no-audit --no-fund "$TMP/$TARBALL"
  echo "install: urlcode $VERSION installed"
fi

if [ -z "$VERIFY_ATTESTATION" ]; then
  # The downloaded copy is removed on exit, so name where to fetch it again.
  echo "install: verify the signed provenance of this release with"
  echo "  curl -fsSLO $BASE/$TARBALL"
  echo "  gh attestation verify $TARBALL --repo $REPO"
fi

}

main "$@"
