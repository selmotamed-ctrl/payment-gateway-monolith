#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export LD_LIBRARY_PATH="/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec bunx playwright test "$@"
