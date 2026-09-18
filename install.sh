#!/bin/sh
# URLCode installer. Downloads a published release tarball, verifies its
# SHA-256 against the release's signed SHA256SUMS, and installs the CLI with npm.
#
#   curl -fsSL https://raw.githubusercontent.com/jimhoyd-com/urlcode/main/install.sh | sh
#   ... | sh -s -- --version 0.3.0 --prefix "$HOME/.local"   # pin a release; omit --version for the latest
#
# This script never runs project code and never needs root for a --prefix install.
set -eu

REPO=jimhoyd-com/urlcode
VERSION=""
PREFIX=""
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13

usage() {
  cat <<'USAGE'
Usage: install.sh [--version X.Y.Z] [--prefix DIR]

  --version  Release to install. Defaults to the latest published release.
  --prefix   Install into DIR/lib/node_modules and link DIR/bin/urlcode.
             Defaults to the npm global prefix, which may require privileges.
  --help     Show this message.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { echo "install: --version needs a value" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
    --prefix)  [ $# -ge 2 ] || { echo "install: --prefix needs a value" >&2; exit 2; }; PREFIX="$2"; shift 2 ;;
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
if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -qO "$2" "$1"; }
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
# signed provenance with `gh attestation verify` after installing.
BASE="${URLCODE_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/v$VERSION}"
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
echo "install: checksum verified"

# --ignore-scripts: a package install must not execute lifecycle code.
if [ -n "$PREFIX" ]; then
  npm install --global --ignore-scripts --no-audit --no-fund --prefix "$PREFIX" "$TMP/$TARBALL"
  echo "install: urlcode $VERSION installed; add $PREFIX/bin to PATH if it is not already there"
else
  npm install --global --ignore-scripts --no-audit --no-fund "$TMP/$TARBALL"
  echo "install: urlcode $VERSION installed"
fi

echo "install: verify the signed provenance of this release with"
echo "  gh attestation verify $TARBALL --repo $REPO"
