#!/usr/bin/env bash
set -Eeuo pipefail
echo 'CFL Host updates require an explicit verified fork package. Extract it and run its install.sh with the retained prefix/data directory; verify identity and diagnostics before switching traffic.' >&2
exit 2
