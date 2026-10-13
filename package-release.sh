#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${1:-$PWD/aru-cfl-host.tar.gz}"
case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
cd "$root"
bun run build
node tools/build-runtime.mjs --check
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/package/src" "$work/package/vendor/lamplit-contracts" "$(dirname "$output")"
cp package.json bun.lock LICENSE THIRD-PARTY-NOTICES.md README.md README.en.md "$work/package/"
cp -R src/cfl "$work/package/src/"
cp vendor/lamplit-contracts/package.json vendor/lamplit-contracts/LICENSE vendor/lamplit-contracts/PROVENANCE.md "$work/package/vendor/lamplit-contracts/"
cp -R vendor/lamplit-contracts/dist "$work/package/vendor/lamplit-contracts/"
mkdir -p "$work/package/docs"
cp docs/operator-reference.md docs/device-acceptance.md "$work/package/docs/"
cp run-node.sh install.sh aru-selfhostctl aru-selfhost.service "$work/package/"
(cd "$work/package" && bun install --production --frozen-lockfile --cache-dir "$work/cache")
# Native sharp binaries belong to the packaging OS/architecture. Linux CI builds Linux.
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({schema:"aru.cfl.release.v1",platform:process.platform,arch:process.arch,contracts:"98d55d1019ad102e46dbde8526bf6f1e32af097b"})+"\n")' "$work/package/release.json"
tar -czf "$output" -C "$work/package" .
(cd "$(dirname "$output")" && shasum -a 256 "$(basename "$output")") > "$output.sha256"
echo "$output"
