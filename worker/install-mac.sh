#!/bin/bash
# Installs the worker as a macOS background service: starts at login, restarts if it dies.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
DIR="$HOME/.floor-swap-worker"
LABEL="ca.mybuilder.floor-swap-worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$DIR/auth.json" ] || { echo "No ChatGPT login yet. Run: node worker/login.mjs"; exit 1; }
[ -f "$DIR/config.json" ] || { echo "No config yet. Run: node worker/setup.mjs --url ... --key ..."; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/worker/worker.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/worker.log</string>
  <key>StandardErrorPath</key><string>$DIR/worker.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 4
echo "Service installed. Last log lines:"
tail -n 5 "$DIR/worker.log" || true
