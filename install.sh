#!/usr/bin/env bash
set -Eeuo pipefail
# Install an explicitly supplied, verified fork package; never fetch official Host.
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix=""; data=""; cfl=""; public=""
while (($#)); do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --data-dir) data="$2"; shift 2 ;;
    --cfl-origin) cfl="$2"; shift 2 ;;
    --base-url) public="$2"; shift 2 ;;
    *) echo 'Usage: install.sh --prefix ABSOLUTE_PATH --data-dir ABSOLUTE_PATH --cfl-origin LOOPBACK_ORIGIN --base-url PUBLIC_ORIGIN' >&2; exit 2 ;;
  esac
done
[[ "$prefix" == /* && "$data" == /* && -n "$cfl" && -n "$public" ]] || { echo 'Explicit prefix, data directory and origins required' >&2; exit 2; }
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]] || { echo 'Node 24 required' >&2; exit 1; }
[[ -f "$source_root/release.json" && -d "$source_root/node_modules" ]] || { echo 'Run install.sh from an extracted package' >&2; exit 1; }
node --input-type=module -e 'import {readFileSync} from "node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.schema!=="aru.cfl.release.v1"||r.platform!==process.platform||r.arch!==process.arch)throw Error("Package OS/architecture mismatch")' "$source_root/release.json"
# Test loading the delivered public client/image dependency before activation.
(cd "$source_root" && node --input-type=module -e 'await import("@lamplit/contracts/client");await import("sharp")')
node "$source_root/src/cfl/cli.mjs" --check-state --data-dir "$data"
mkdir -p "$prefix" "$data"
chmod 700 "$data"
release="$prefix/releases/$(date +%Y%m%d%H%M%S)-$$"
mkdir -p "$release"
cp -R "$source_root/." "$release/"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({dataDir:process.argv[2],cflOrigin:process.argv[3],baseUrl:process.argv[4]}),{mode:0o600})' "$prefix/config.json" "$data" "$cfl" "$public"
previous="$(readlink "$prefix/current" || true)"
[[ -z "$previous" ]] || { ln -sfn "$previous" "$prefix/previous"; }
ln -s "$release" "$prefix/current.next"
node -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$prefix/current.next" "$prefix/current"
echo "Installed package at $release. Configure the provided service as your CFL service owner, then verify diagnostics before switching traffic."
