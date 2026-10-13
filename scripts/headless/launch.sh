#!/bin/bash
# usage: launch.sh <name> <cdpPort> [project.palmier]
# Launches the built app (out/) on a private Xvfb with fresh XDG dirs under $BASE/<name>, a random MCP port,
# CDP on <cdpPort> and the main-process inspector on <cdpPort>+1000. Log: $BASE/<name>/app.log. NOGL=1 disables WebGL.
# WAYLAND_DISPLAY must be unset: with it set, Electron ignores Xvfb and opens on the user's real display.
set -e
BASE=${PALMIER_HEADLESS_DIR:-${TMPDIR:-/tmp}/palmier-headless}
NAME=$1; PORT=$2; PROJ=$3
ROOT=$BASE/$NAME
mkdir -p "$ROOT/data" "$ROOT/config/framewright" "$ROOT/cache" "$ROOT/docs" "$ROOT/state"
# First-run overlays (onboarding / What's New) are pre-dismissed so they don't cover Home; FIRSTRUN=1 keeps them.
SEEN=""
[ -z "$FIRSTRUN" ] && SEEN=", \"hasSeenWelcome\": true, \"lastSeenVersion\": \"$(node -p "require('$(cd "$(dirname "$0")/../.." && pwd)/package.json').version")\""
[ -f "$ROOT/config/framewright/settings.json" ] || echo "{\"mcpPort\": $((20000 + RANDOM % 10000))$SEEN}" > "$ROOT/config/framewright/settings.json"
cd "$(dirname "$0")/../.."
export XDG_DATA_HOME=$ROOT/data XDG_CONFIG_HOME=$ROOT/config XDG_CACHE_HOME=$ROOT/cache XDG_DOCUMENTS_DIR=$ROOT/docs XDG_STATE_HOME=$ROOT/state
# Crash log goes to $XDG_STATE_HOME; skills and "Add to External Agent" copies stay out of the real home unless overridden.
export PALMIER_SKILLS_DIR=${PALMIER_SKILLS_DIR:-$ROOT/skills} PALMIER_EXTERNAL_SKILLS_HOME=${PALMIER_EXTERNAL_SKILLS_HOME:-$ROOT/home}
export ELECTRON_ENABLE_LOGGING=1
unset WAYLAND_DISPLAY; export XDG_SESSION_TYPE=x11 ELECTRON_OZONE_PLATFORM_HINT=x11
[ -n "$PROJ" ] && export PALMIER_OPEN_PROJECT=$PROJ
if [ -n "$NOGL" ]; then GLFLAGS="--disable-gpu"; else GLFLAGS="--use-angle=swiftshader --enable-unsafe-swiftshader"; fi
# Private D-Bus so desktop notifications and keyring calls never reach the user's real session
# (REAL_DBUS=1 to opt out); basic password store keeps safeStorage off the real keyring.
DBUS_WRAP=""
if [ -z "$REAL_DBUS" ]; then
  if command -v dbus-run-session >/dev/null; then DBUS_WRAP="dbus-run-session --"; else export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent; fi
fi
exec $DBUS_WRAP xvfb-run -a -s "-screen 0 1920x1200x24" ./node_modules/.bin/electron . --ozone-platform=x11 $GLFLAGS --remote-debugging-port="$PORT" --inspect=$((PORT + 1000)) --no-sandbox --password-store=basic > "$ROOT/app.log" 2>&1
