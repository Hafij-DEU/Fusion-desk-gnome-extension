#!/bin/bash
# Fusion Desk self-tests that need no shell: an isolated schema, the memory
# GSettings backend and a temp config dir (never touches your real settings).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/schemas" "$T/cfg/harbor"
cp "$ROOT"/schemas/*.xml "$T/schemas/"
glib-compile-schemas "$T/schemas"
printf 'effect=STRONG\nstyle=PLANNER\n' > "$T/cfg/harbor/glass-global"
printf 'global\n' > "$T/cfg/harbor/glass"
XDG_CONFIG_HOME="$T/cfg" GSETTINGS_BACKEND=memory gjs -m "$ROOT/tools/tests/restorePoints.js" "$ROOT" "$T" 2>&1 | grep -E '^(PASS|FAIL)'
