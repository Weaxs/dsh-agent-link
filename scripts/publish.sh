#!/usr/bin/env bash
# Publish the current package under both names:
#   @weaxs/dsh-agent-link  (scoped, the name in package.json)
#   dsh-agent-link         (unscoped, identical payload)
# Run `npm login` first. Pass --dry-run to preview without publishing.
set -euo pipefail

cd "$(dirname "$0")/.."

scoped="$(node -p "require('./package.json').name")"
unscoped="${scoped#@*/}"
version="$(node -p "require('./package.json').version")"

npm whoami >/dev/null || { echo "Not logged in to npm; run: npm login" >&2; exit 1; }

echo "Publishing ${scoped}@${version}"
npm publish --access public "$@"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
npm pack --pack-destination "$stage" >/dev/null
tar -xzf "$stage"/*.tgz -C "$stage"
(
  cd "$stage/package"
  npm pkg set "name=${unscoped}"
  echo "Publishing ${unscoped}@${version}"
  npm publish --access public "$@"
)
